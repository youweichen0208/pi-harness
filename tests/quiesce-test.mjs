import { mergeSnapshot } from "./lib/snapshots.mjs";
/** OMP drain admission, existing work completion, Origin checks and credential redaction. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'omp-quiesce-'));
const cwd = join(root, 'project'), data = join(root, 'data'), agent = join(data, 'omp/agent');
for (const path of [cwd, agent]) mkdirSync(path, { recursive: true });
const sockets = new Set();
let harness, requests = 0, finish;
const mock = createServer(async (req, res) => {
	for await (const chunk of req) { /* Local fixture, never a real provider. */ }
	requests++;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `drain-${requests}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
	const complete = () => {
		emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
		emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `DRAIN_DONE_${requests}` } });
		emit('content_block_stop', { index: 0 });
		emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
		emit('message_stop', {}); res.end();
	};
	if (requests === 1) finish = complete; else complete();
});
async function wait(predicate, label) {
	for (let i = 0; i < 600; i++) { if (await predicate()) return; await sleep(50); }
	throw Error(`Timed out: ${label}\n${harness?.logs.slice(-1000)}`);
}
function control(cmd) {
	const path = process.platform === 'win32' ? `\\\\.\\pipe\\pi-harness-${harness.port}` : join(data, 'pi-harness.sock');
	return new Promise((resolve, reject) => {
		const socket = createConnection(path); let buffer = '';
		socket.setTimeout(2000, () => socket.destroy(Error('Control request timed out')));
		socket.on('connect', () => socket.write(JSON.stringify({ cmd }) + '\n'));
		socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.destroy(); try { resolve(JSON.parse(buffer)); } catch (error) { reject(error); } } });
		socket.on('error', reject);
	});
}
async function connect(origin, id = 'tester') {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`, { origin }); sockets.add(ws);
	const client = { ws, opened: false, closed: false, code: undefined, messages: [], state: undefined, send: message => ws.send(JSON.stringify(message)) };
	ws.on('open', () => { client.opened = true; client.send({ type: 'hello', clientId: id }); });
	ws.on('message', raw => { const message = JSON.parse(raw); client.messages.push(message); client.state = mergeSnapshot(client.state, message); });
	ws.on('error', () => {});
	ws.on('close', code => { client.closed = true; client.code = code; });
	await wait(() => client.closed || client.messages.some(m => m.type === 'ready'), 'ready or explicit rejection');
	return client;
}
try {
	const port = await listenIsolated(mock);
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'PRIVATE_KEY_SENTINEL', headers: { 'X-Private': 'PRIVATE_HEADER_SENTINEL' }, models: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 200000 }] } } }));
	harness = await startIsolatedHarness({ ...(process.argv.includes('--source') ? { args: ['--import', 'tsx', 'server/index.ts'] } : {}), env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data } });
	const origin = `http://127.0.0.1:${harness.port}`;
	const status = await control('status');
	assert.equal(status.ok, true); assert.equal(status.pid, harness.child.pid); assert.equal(status.cwd, cwd); assert.equal(status.quiesced, false);
	assert.equal((await connect('https://evil.example')).opened, false, 'foreign origin refused');
	assert.equal((await connect(`http://127.0.0.1:${harness.port + 1}`)).opened, false, 'different port refused');
	const client = await connect(origin);
	assert(client.opened && client.state, 'same authority receives ready and snapshot');
	client.send({ type: 'list_models_config' });
	await wait(() => client.messages.some(m => m.type === 'models_config'), 'model configuration');
	const config = client.messages.find(m => m.type === 'models_config');
	assert(config.providers.length > 0, 'redaction must be tested against a real configured provider');
	assert(config.providers.every(p => !('headers' in p)));
	assert(!JSON.stringify(client.messages).includes('PRIVATE_HEADER_SENTINEL'));
	assert(!JSON.stringify(client.messages).includes('PRIVATE_KEY_SENTINEL'));
	client.send({ type: 'set_model', modelId: 'fixture/fixture' });
	await wait(() => client.state.model?.id === 'fixture', 'model selected');
	client.send({ type: 'terminal_create', terminalId: 'existing-terminal', cwd, cols: 80, rows: 24 });
	await wait(() => client.messages.some(m => m.type === 'terminal_list' && m.terminals.some(t => t.id === 'existing-terminal' && t.running)), 'existing terminal');
	client.send({ type: 'prompt', text: 'Start before draining', requestId: 'initial' });
	await wait(() => finish && client.state.isStreaming, 'existing native task');
	assert.equal((await control('quiesce')).ok, true);
	const paused = await control('status');
	assert(paused.quiesced && typeof paused.quiescedSince === 'number');
	assert.equal(paused.activeConversations, 1);
	const directoryExisted = existsSync(join(agent, 'extensions'));
	const extensionPath = prepare => fetch(`${origin}/api/omp-paths`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ clientId: 'tester', cwd, conversationId: client.state.conversationId, target: { kind: 'extensions' }, prepare }) });
	assert.equal((await extensionPath(false)).status, 200, 'directory metadata stays readable during drain');
	assert.equal((await extensionPath(true)).status, 400, 'directory preparation is rejected during drain');
	assert.equal(existsSync(join(agent, 'extensions')), directoryExisted);
	const attached = await connect(origin);
	assert(attached.messages.some(m => m.type === 'ready'), 'existing client reconnects while draining');
	attached.send({ type: 'prompt', text: 'Must not enter model queue', requestId: 'rejected' });
	await wait(() => attached.messages.some(m => m.type === 'prompt_result' && m.requestId === 'rejected'), 'durable prompt rejection');
	assert(attached.messages.some(m => m.type === 'prompt_result' && m.requestId === 'rejected' && !m.ok && m.receipt === 'rejected'));
	assert(attached.messages.some(m => m.type === 'notice' && m.level === 'error'));
	assert.equal(requests, 1);
	const fresh = await connect(origin, 'new-client');
	assert(fresh.closed && fresh.code === 4403, 'new clients explicitly refused while draining');
	for (const type of ['terminal_create', 'run_command']) {
		const start = attached.messages.length;
		attached.send({ type, terminalId: `blocked-${type}`, cwd, command: 'echo MUST_NOT_RUN', cols: 80, rows: 24 });
		await wait(() => attached.messages.slice(start).some(m => m.type === 'notice' || m.type === 'terminal_list'), `${type} response`);
		const events = attached.messages.slice(start);
		assert(events.some(m => m.type === 'notice' && m.level === 'error'), `${type} must refuse new PTYs during drain`);
		assert(!events.some(m => m.type === 'terminal_list' && m.terminals.some(t => t.id === `blocked-${type}`)), 'no new PTY created');
	}
	attached.send({ type: 'terminal_kill', terminalId: 'existing-terminal' });
	await wait(() => attached.messages.some(m => m.type === 'terminal_exit' && m.terminalId === 'existing-terminal'), 'existing terminal can be stopped during drain');
	finish();
	await wait(() => !client.state.isStreaming && JSON.stringify(client.state.messages).includes('DRAIN_DONE_1'), 'existing task completes during drain');
	assert.equal((await control('status')).activeConversations, 0);
	assert.equal(requests, 1, 'rejected prompt never starts after existing task settles');
	assert.equal((await control('unquiesce')).ok, true);
	assert.equal((await control('status')).quiesced, false);
	const resumed = await connect(origin, 'new-client');
	assert(resumed.messages.some(m => m.type === 'ready'), 'new client admitted after unquiesce');
	client.send({ type: 'prompt', text: 'Continue after drain', requestId: 'resumed' });
	await wait(() => !client.state.isStreaming && JSON.stringify(client.state.messages).includes('DRAIN_DONE_2'), 'new work after unquiesce');
	assert.equal(requests, 2);
	assert.equal((await control('explode')).ok, false);
	console.log('PASS OMP drain: existing task completes, rejected prompts never run, new clients/PTYs refused, reconnect/read access retained, unquiesce resumes, Origin and secret boundaries intact');
} finally {
	for (const ws of sockets) ws.terminate();
	await harness?.stop(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
