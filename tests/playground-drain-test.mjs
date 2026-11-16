/** Actual Playground admission and native work through the local control socket. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
import { ompTestExecutable, ompTestRoot, ompTestPackaged } from './lib/omp-runtime-location.mjs';

const root = mkdtempSync(join(tmpdir(), 'omp-pg-drain-'));
const cwd = join(root, 'project'), data = join(root, 'data'), agent = join(data, 'omp/agent');
for (const directory of [cwd, agent]) mkdirSync(directory, { recursive: true });
const starts = join(root, 'starts'), gate = join(root, 'opening-gate'), preload = join(root, 'preload.mjs');
const hostGate = join(root, 'host-gate'), hostStarts = join(root, 'host-starts');
writeFileSync(preload, `import { appendFileSync, existsSync } from 'node:fs';
const bootstrap = JSON.parse(process.env.PI_WEB_OMP_BOOTSTRAP || '{}');
if (!bootstrap.operation && !bootstrap.restricted && existsSync(${JSON.stringify(hostGate)})) {
 appendFileSync(${JSON.stringify(hostStarts)}, 'start\\n');
 while (existsSync(${JSON.stringify(hostGate)})) await Bun.sleep(20);
}
if (!bootstrap.operation && bootstrap.restricted?.toolNames?.includes('propose_playground_code')) {
 appendFileSync(${JSON.stringify(starts)}, 'start\\n');
 while (existsSync(${JSON.stringify(gate)})) await Bun.sleep(20);
}
const original = fetch; const local = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw Error('EXTERNAL_NETWORK_REFUSED'); return original(input, init); }; Object.assign(local, original); globalThis.fetch = local;`);
let harness, requests = 0, mode = 'hold';
let observed;
const sockets = new Set(), held = new Set();
const provider = createServer(async (req, res) => {
	for await (const _ of req) { /* Drain the local fixture input. */ }
	const id = ++requests;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
	emit('message_start', { message: { id: `drain-${id}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 20, output_tokens: 0 } } });
	if (mode === 'retry') {
		// Fail after content so the agent recovery loop, rather than the
		// provider's pre-content transport retry, owns the retry lifecycle.
		emit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
		emit('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Local fixture reasoning' } });
		emit('content_block_stop', { index: 0 });
		emit('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }); res.end(); return;
	}
	const complete = () => {
		emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
		emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `PLAYGROUND_DRAIN_DONE_${id}` } });
		emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }); emit('message_stop', {}); res.end();
	};
	if (mode === 'normal') complete();
	else { const entry = { res, complete }; held.add(entry); res.once('close', () => held.delete(entry)); }
});
async function wait(fn, label) {
	for (let i = 0; i < 600; i++) { if (await fn()) return; await sleep(30); }
	throw Error(`Timed out: ${label}; ${JSON.stringify({ requests, mode, starts: startCount(), running: observed?.state?.running, recovery: observed?.state?.recovery, errors: observed?.messages.filter(m => m.type === 'playground_chat_error').slice(-3) })}\n${harness?.logs.slice(-1200)}`);
}
const startCount = () => existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n').length : 0;
function control(cmd) {
	const path = process.platform === 'win32' ? `\\\\.\\pipe\\pi-harness-${harness.port}` : join(data, 'pi-harness.sock');
	return new Promise((resolve, reject) => {
		const socket = createConnection(path); let text = '';
		socket.setTimeout(2000, () => socket.destroy(Error('Control timeout')));
		socket.on('connect', () => socket.write(JSON.stringify({ cmd }) + '\n'));
		socket.on('data', chunk => { text += chunk; if (text.includes('\n')) { socket.destroy(); try { resolve(JSON.parse(text)); } catch (error) { reject(error); } } });
		socket.on('error', reject);
	});
}
async function connect(id = 'playground-drain', ready = true) {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`); sockets.add(ws);
	const client = { ws, messages: [], state: undefined, send: message => ws.send(JSON.stringify(message)) };
	ws.on('open', () => client.send({ type: 'hello', clientId: id }));
	ws.on('message', raw => { const m = JSON.parse(raw); client.messages.push(m); if (m.type === 'playground_chat_state') client.state = m.state; });
	ws.on('error', () => {});
	if (ready) await wait(() => client.messages.some(m => m.type === 'ready'), 'client ready');
	return client;
}
const request = (client, action, fields = {}) => {
	const requestId = crypto.randomUUID(); client.send({ type: 'playground_chat', requestId, conversationId: client.state?.id, action, ...fields }); return requestId;
};
const context = { code: 'print(1)', parameters: '', output: '', partial: false, stale: false, truncated: false };
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ modelRoles: { default: 'fixture/fixture' }, skills: { enabled: false }, cacheWarming: { enabled: false }, compaction: { enabled: false }, retry: { enabled: true, baseDelayMs: 10000, maxRetries: 2 } }));
	const env = testEnv({ PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_WEB_PKG_ROOT: ompTestRoot, ...(ompTestPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}), BUN_OPTIONS: `--preload=${preload}` });
	for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)) delete env[key];
	const launch = { env, executable: ompTestExecutable, args: [join(ompTestRoot, 'dist/server/index.js')] };
	harness = await startIsolatedHarness(launch);
	writeFileSync(hostGate, 'hold host startup');
	const client = await connect('playground-drain', false); observed = client;
	await wait(() => existsSync(hostStarts), 'native host startup held');
	assert.equal((await control('status')).activeConversations, 1, 'main chat startup also blocks update');
	rmSync(hostGate); await wait(() => client.messages.some(m => m.type === 'ready'), 'host ready');
	await wait(async () => (await control('status')).activeConversations === 0, 'initial idle');
	writeFileSync(gate, 'hold startup');
	request(client, 'open'); await wait(() => startCount() === 1, 'native Playground startup held');
	assert.equal((await control('status')).activeConversations, 1, 'opening Playground must block update even before running=true');
	assert.equal((await control('quiesce')).ok, true);
	rmSync(gate); await wait(() => client.state?.model, 'previously admitted open completes');
	await wait(async () => (await control('status')).activeConversations === 0, 'opened idle session');
	await control('unquiesce');
	request(client, 'send', { text: 'Hold while draining', context });
	await wait(() => held.size === 1 && client.state.running, 'native task held');
	assert.equal((await control('status')).activeConversations, 1, 'running Playground included');
	await control('quiesce');
	for (const action of ['send', 'new', 'switch', 'model', 'thinking', 'reopen']) {
		const id = request(client, action, { text: 'MUST_NOT_RUN', context, targetId: client.state.id, model: { provider: 'fixture', id: 'fixture' }, thinking: 'off' });
		await wait(() => client.messages.some(m => m.type === 'playground_chat_error' && m.requestId === id && m.error === 'Service paused'), `${action} rejected during drain`);
	}
	const peer = await connect(); request(peer, 'open'); await wait(() => peer.state?.running, 'reconnect reads existing task');
	assert.equal((await control('status')).activeConversations, 1, 'shared assistant counted once across sockets');
	const receipt = request(peer, 'receipt'); await wait(() => peer.messages.some(m => m.type === 'playground_chat_result' && m.result.requestId === receipt), 'receipt remains available');
	assert.equal(requests, 1); for (const entry of held) entry.complete();
	await wait(() => !client.state.running && JSON.stringify(client.state.messages).includes('PLAYGROUND_DRAIN_DONE_1'), 'admitted task finishes while draining');
	await wait(async () => (await control('status')).activeConversations === 0, 'settled work no longer blocks update');
	assert.equal(requests, 1, 'rejected task never queued or replayed');
	request(peer, 'stop'); await wait(async () => (await control('status')).activeConversations === 0, 'stopped worker disposal');
	const beforeStarts = startCount(), beforeMessages = peer.messages.length;
	request(peer, 'open'); await wait(() => peer.messages.slice(beforeMessages).some(m => m.type === 'playground_chat_state'), 'stopped history read while draining');
	assert.equal(startCount(), beforeStarts, 'read during drain must not revive stopped worker');
	await control('unquiesce'); mode = 'retry'; request(client, 'send', { text: 'Retry before drain', context });
	await wait(() => client.state.recovery?.retry, 'native retry');
	assert.equal((await control('status')).activeConversations, 1, 'native recovery remains busy');
	await control('quiesce'); const retryCount = requests;
	request(client, 'cancel_recovery', { operationId: client.state.recovery.retry.id });
	await wait(() => !client.state.recovery?.retry && !client.state.running, 'cancel native retry during drain');
	await wait(async () => (await control('status')).activeConversations === 0, 'cancelled retry settled');
	assert.equal(requests, retryCount, 'cancel never replays request');
	await control('unquiesce'); mode = 'hold'; request(client, 'send', { text: 'Stop while draining', context });
	await wait(() => held.size === 1 && client.state.running, 'next native request'); await control('quiesce'); request(client, 'stop');
	await wait(() => held.size === 0 && !client.state.running, 'Stop closes model stream during drain');
	await wait(async () => (await control('status')).activeConversations === 0, 'Stop fully settles');
	// The same read-only contract applies after a host restart with no session object.
	for (const ws of sockets) ws.terminate(); await harness.stop();
	harness = await startIsolatedHarness(launch); const restored = await connect(); await control('quiesce');
	const beforeFresh = startCount(); request(restored, 'open'); await wait(() => restored.state, 'read catalog without an agent');
	assert.equal(startCount(), beforeFresh, 'draining open must not construct a new native session');
	await control('unquiesce'); mode = 'normal'; const beforeResume = requests;
	request(restored, 'send', { text: 'Explicit resume', context });
	await wait(() => requests === beforeResume + 1 && !restored.state.running && JSON.stringify(restored.state.messages).includes(`PLAYGROUND_DRAIN_DONE_${requests}`), 'explicit work resumes after drain');
	console.log('PASS Playground drain: opening/running/retry counted once, quiesce rejects new work, reconnect reads without revival, existing completion/cancel/Stop and explicit resume');
} finally {
	rmSync(gate, { force: true }); rmSync(hostGate, { force: true }); for (const ws of sockets) ws.terminate();
	await harness?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
