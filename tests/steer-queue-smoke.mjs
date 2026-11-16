/** Real WebSocket admission and native OMP queues; local model, zero paid tokens. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
import { mergeSnapshot } from './lib/snapshots.mjs';
import { PROTOCOL_VERSION } from '../dist/server/protocol-version.js';

const root = mkdtempSync(join(tmpdir(), 'omp-queue-wire-')), data = join(root, 'data'), agent = join(data, 'omp/agent');
mkdirSync(agent, { recursive: true });
const requests = [], held = [], clients = [];
let harness, holdNext = false;
const wait = async (predicate, label) => { for (let i = 0; i < 1200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('Timed out ' + label); };
const model = createServer(async (request, response) => {
	let raw = ''; for await (const chunk of request) raw += chunk;
	requests.push(JSON.parse(raw));
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event('message_start', { message: { id: `fixture-${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
	if (holdNext) { holdNext = false; await new Promise(resolve => { held.push(resolve); response.once('close', resolve); }); }
	if (response.destroyed) return;
	event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
	event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Queue fixture complete.' } });
	event('content_block_stop', { index: 0 });
	event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
	event('message_stop', {}); response.end();
});
async function connect(id) {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	const client = { ws, state: undefined, events: [], ready: false, send: message => ws.send(JSON.stringify(message)) }; clients.push(client);
	ws.on('message', raw => {
		const message = JSON.parse(raw); client.events.push(message); client.state = mergeSnapshot(client.state, message);
		if (message.type === 'ready') client.ready = true;
	});
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	client.send({ type: 'hello', clientId: id, protocolVersion: PROTOCOL_VERSION });
	await wait(() => client.ready && client.state?.model, id + ' ready');
	return client;
}
const target = client => ({ cwd: client.state.cwd, conversationId: client.state.conversationId, sessionId: client.state.sessionId });
async function exchange(client, message) {
	const start = client.events.length; client.send(message);
	await wait(() => client.events.slice(start).some(event => event.type === 'prompt_result' && event.requestId === message.requestId), 'prompt receipt');
	return client.events.slice(start).find(event => event.type === 'prompt_result' && event.requestId === message.requestId);
}
async function hold(client, marker) {
	const before = requests.length; holdNext = true;
	assert.equal((await exchange(client, { type: 'prompt', text: marker, requestId: marker, target: target(client) })).receipt, 'accepted');
	await wait(() => requests.length === before + 1 && held.length && client.state.isStreaming, 'held native request');
	return before;
}
const requestText = payload => payload.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).join('\n');
try {
	const port = await listenIsolated(model);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 1000000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false } }));
	const env = testEnv({ PI_WEB_CWD: root, PI_WEB_DATA_DIR: data });
	for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
	harness = await startIsolatedHarness({ env });
	const client = await connect('queue'), sibling = await connect('sibling');
		assert.equal(sibling.state.sessionFile, client.state.sessionFile, 'a new window initially reads the latest native history');
	for (const [label, queue] of [['default', undefined], ['steer', false], ['follow-up', true]]) {
		const before = await hold(client, `PARENT_${label}`), marker = `QUEUED_${label}`;
		const message = { type: 'prompt', text: marker, requestId: marker, target: target(client), ...(queue === undefined ? {} : { queue }) };
		assert.equal((await exchange(client, message)).receipt, 'accepted');
		const field = queue ? 'followUp' : 'steering';
		await wait(() => client.state.queue[field].includes(marker), label + ' native queue');
			if (label === 'default') {
				await new Promise(resolve => setTimeout(resolve, 2200));
				assert.equal(client.state.sessionPersistence.failed, false);
				assert.equal(sibling.state.sessionPersistence.failed, false, 'a passive reader must not mark another native writer as corrupt');
			}
		assert.equal((await exchange(client, message)).receipt, 'accepted', 'duplicate admission replays the receipt');
		assert.equal(client.state.queue[field].filter(text => text === marker).length, 1);
		assert.equal(requests.length, before + 1, 'queue admission must not start another model request before the held turn ends');
		assert.deepEqual(sibling.state.queue, { steering: [], followUp: [] });
		assert.equal((await exchange(client, { ...message, requestId: marker + '-wrong-owner', target: target(sibling) })).receipt, 'rejected');
		held.shift()();
		await wait(() => requests.length === before + 2 && !client.state.isStreaming && !client.state.queue.steering.length && !client.state.queue.followUp.length, label + ' delivery');
		assert.equal(requestText(requests.at(-1)).split(marker).length, 2, 'native model context contains the queued request once');
	}
	const recallBefore = await hold(client, 'PARENT_RECALL');
	assert.equal((await exchange(client, { type: 'prompt', text: 'RECALLED_INPUT', queue: true, requestId: 'recall-input', target: target(client) })).receipt, 'accepted');
	await wait(() => client.state.queue.followUp.includes('RECALLED_INPUT'), 'recall queue');
	client.send({ type: 'recall_queue', conversationId: client.state.conversationId, requestId: 'recall' });
	await wait(() => client.events.some(event => event.type === 'queue_recalled' && event.requestId === 'recall'), 'recall delivery');
	assert.equal(client.events.find(event => event.type === 'queue_recalled' && event.requestId === 'recall').text, 'RECALLED_INPUT');
	client.send({ type: 'queue_recall_ack', conversationId: client.state.conversationId, requestId: 'recall' });
	held.shift()(); await wait(() => !client.state.isStreaming, 'parent after recall');
	assert.equal(requests.length, recallBefore + 1, 'recalled content must not be sent to the model');
	const stopBefore = await hold(client, 'PARENT_STOP');
	const stopped = { type: 'prompt', text: 'STOPPED_QUEUED_INPUT', queue: true, requestId: 'stopped-input', target: target(client) };
	assert.equal((await exchange(client, stopped)).receipt, 'accepted');
	await wait(() => client.state.queue.followUp.includes(stopped.text), 'queue before Stop');
	client.send({ type: 'abort' }); await wait(() => !client.state.isStreaming && !client.state.queue.followUp.length, 'Stop clears native queue');
	held.shift()();
	assert.equal((await exchange(client, stopped)).receipt, 'accepted', 'a past receipt cannot restart cancelled work');
	assert.equal(requests.length, stopBefore + 1);
		const continuationStart = client.events.length;
		const continuation = await exchange(client, { type: 'prompt', text: 'EXPLICIT_CONTINUATION', requestId: 'continue', target: target(client) });
		assert.equal(continuation.receipt, 'accepted', JSON.stringify(client.events.slice(continuationStart).filter(event => event.type === 'notice')));
	await wait(() => requests.length === stopBefore + 2 && !client.state.isStreaming, 'explicit continuation');
	assert(!requestText(requests.at(-1)).includes(stopped.text), 'Stop does not replay queued side effects');
	assert.equal(sibling.state.messages.length, 0, 'other clients retain their own empty history');
		const siblingRequest = requests.length;
		assert.equal((await exchange(sibling, { type: 'prompt', text: 'SIBLING_CONTINUATION', requestId: 'sibling-continue', target: target(sibling) })).receipt, 'accepted');
		await wait(() => requests.length === siblingRequest + 1 && !sibling.state.isStreaming && sibling.state.messages.some(message => message.role === 'assistant'), 'native reader relocation');
		assert.notEqual(sibling.state.sessionFile, client.state.sessionFile);
		assert.equal(sibling.state.sessionPersistence.relocation.reason, 'open-elsewhere');
		assert.equal(sibling.state.sessionPersistence.failed, false);
		assert.equal(client.state.sessionPersistence.failed, false);
		assert(!requestText(requests.at(-1)).includes('EXPLICIT_CONTINUATION'), 'the second writer forks its own original view');
		console.log('PASS OMP queue wire: steer/follow-up delivery, deduplication, target isolation, recall, Stop/continue without replay, passive reader isolation and native writer relocation');
} finally {
	for (const release of held) release(); for (const client of clients) client.ws.terminate();
	await harness?.stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
