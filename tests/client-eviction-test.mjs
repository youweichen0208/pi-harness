import { mergeSnapshot } from "./lib/snapshots.mjs";
/** Native OMP idle reclamation through /ws: background work, PTYs, reconnects and persisted selection. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'omp-evict-'));
const data = join(root, 'data'), cwd = join(root, 'project'), other = join(root, 'other'), agent = join(data, 'omp/agent');
for (const path of [cwd, other, agent]) mkdirSync(path, { recursive: true });
const sockets = new Set();
let harness, finish, requests = 0;
const mock = createServer(async (req, res) => {
	for await (const chunk of req) { /* Consume this local fixture request. */ }
	requests++;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
	emit('message_start', { message: { id: 'idle-fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
	finish = () => {
		emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
		emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Background task completed' } });
		emit('content_block_stop', { index: 0 });
		emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
		emit('message_stop', {}); res.end();
	};
});
async function until(predicate, label, ms = 30000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) { if (await predicate()) return; await sleep(50); }
	throw Error(`Timed out: ${label}\n${harness?.logs.slice(-1200)}`);
}
const status = () => new Promise((resolve, reject) => {
	const path = process.platform === 'win32' ? `\\\\.\\pipe\\pi-harness-${harness.port}` : join(data, 'pi-harness.sock');
	const socket = createConnection(path); let buffer = '';
	socket.setTimeout(2000, () => socket.destroy(Error('Control status timed out')));
	socket.on('connect', () => socket.write('{"cmd":"status"}\n'));
	socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.destroy(); try { resolve(JSON.parse(buffer)); } catch (error) { reject(error); } } });
	socket.on('error', reject);
});
async function connect(clientId, earlyClose = false) {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`); sockets.add(ws);
	const client = { ws, state: undefined, messages: [], send: message => ws.send(JSON.stringify(message)) };
	ws.on('message', raw => {
		const message = JSON.parse(raw); client.messages.push(message);
		client.state = mergeSnapshot(client.state, message);
		if (message.type === 'snapshot' && earlyClose) ws.close();
	});
	await once(ws, 'open'); client.send({ type: 'hello', clientId });
	if (earlyClose) { await once(ws, 'close'); assert(!client.messages.some(m => m.type === 'ready'), 'disconnect fixture must close during initialization'); }
	else await until(() => client.messages.some(m => m.type === 'ready') && client.state && !client.state.isStreaming, 'native ready');
	return client;
}
async function close(client) { const closed = once(client.ws, 'close'); client.ws.close(); await closed; }
try {
	const port = await listenIsolated(mock);
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false } }));
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture-only', models: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 200000 }] } } }));
	harness = await startIsolatedHarness({ ...(process.argv.includes('--source') ? { args: ['--import', 'tsx', 'server/index.ts'] } : {}), env: { PI_WEB_DATA_DIR: data, PI_WEB_CWD: cwd, PI_WEB_CLIENT_IDLE_MINUTES: '0.02' } });
	const a = await connect('idle-stay'), b = await connect('idle-leave');
	assert.equal((await status()).clientSessions, 2);
	b.send({ type: 'set_cwd', path: other, requestId: 'switch' });
	await until(() => b.state.cwd === other && !b.state.isStreaming, 'workspace switched');
	b.send({ type: 'set_model', modelId: 'fixture/fixture' });
	await until(() => b.state.model?.id === 'fixture', 'model selected');
	b.send({ type: 'prompt', text: 'Hold this background task', requestId: 'hold' });
	await until(() => finish && b.state.isStreaming, 'native task started');
	const runningConversation = b.state.conversationId;
	b.send({ type: 'new_chat' });
	await until(() => b.state.conversationId !== runningConversation && !b.state.isStreaming, 'task moved to background');
	const savedSession = b.state.sessionId;
	await close(b); await sleep(3000);
	assert.equal((await status()).clientSessions, 2, 'disconnected background task must survive idle timeout');
	assert.equal((await status()).activeConversations, 1);
	finish();
	await until(async () => (await status()).clientSessions === 1, 'idle client evicted after background task settles');
	assert.equal((await status()).connectedClients, 1);
	const back = await connect('idle-leave');
	assert.equal(back.state.cwd, other, 'workspace restored');
	assert.equal(back.state.sessionId, savedSession, 'selected native history restored');
	assert.equal(requests, 1, 'restoration never resends a model request');
	const conversation = back.state.conversationId;
	await close(back);
	const quick = await connect('idle-leave');
	assert.equal(quick.state.conversationId, conversation, 'reconnect before deadline reuses runtime');
	quick.send({ type: 'terminal_create', terminalId: 'idle-terminal', cwd: other, cols: 80, rows: 24 });
	await until(() => quick.messages.some(m => m.type === 'terminal_list' && m.terminals.some(t => t.id === 'idle-terminal' && t.running)), 'live terminal');
	await close(quick); await sleep(3000);
	assert.equal((await status()).clientSessions, 2, 'live terminal prevents eviction');
	const terminal = await connect('idle-leave');
	assert.equal(terminal.state.conversationId, conversation);
	terminal.send({ type: 'terminal_kill', terminalId: 'idle-terminal' });
	await until(() => terminal.messages.some(m => m.type === 'terminal_exit' && m.terminalId === 'idle-terminal'), 'terminal exited');
	await close(terminal);
	await until(async () => (await status()).clientSessions === 1, 'exited terminal history does not prevent eviction');
	await connect('idle-initializing', true);
	await until(async () => (await status()).clientSessions === 1, 'initialization disconnect does not leave a phantom sink');
	assert.equal((await status()).connectedClients, 1);
	assert.equal(requests, 1);
	assert.equal(a.ws.readyState, WebSocket.OPEN, 'connected client survives all idle windows');
	console.log('PASS OMP idle eviction: background task and PTY protected, exited PTY reclaimed, workspace/history restored without replay, reconnect reused, initialization disconnect reclaimed');
} finally {
	for (const ws of sockets) ws.terminate();
	await harness?.stop(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
