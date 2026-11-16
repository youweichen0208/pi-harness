/** Real OMP wire snapshots: append-only deltas, resync, reconnect and navigation. */
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

const root = mkdtempSync(join(tmpdir(), 'omp-snapshot-')), data = join(root, 'data'), agent = join(data, 'omp/agent');
mkdirSync(agent, { recursive: true });
writeFileSync(join(root, 'fixture.txt'), 'Native snapshot tool output\n');
const clients = [], requests = [];
let harness, release, finish, providerError, browser;
const wait = async (predicate, label) => { for (let i = 0; i < 1200; i++) { if (providerError) throw providerError; if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('Timed out ' + label); };
const provider = createServer((request, response) => { void (async () => {
	let raw = ''; for await (const chunk of request) raw += chunk;
	const payload = JSON.parse(raw); requests.push(payload);
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event('message_start', { message: { id: `fixture-${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
	if (requests.length === 1) {
		const read = payload.tools.find(tool => tool.name === '_read');
		assert(read, 'native Anthropic schema advertises its escaped read tool');
		event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'fixture-read', name: read.name, input: {} } });
		event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: join(root, 'fixture.txt') }) } });
		event('content_block_stop', { index: 0 });
		event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } });
	} else {
		event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
		event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'First streamed fragment. ' } });
		await new Promise(resolve => { release = resolve; response.once('close', resolve); });
		if (response.destroyed) return;
		event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Second streamed fragment.' } });
		await new Promise(resolve => { finish = resolve; response.once('close', resolve); });
		if (response.destroyed) return;
		event('content_block_stop', { index: 0 });
		event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } });
	}
	event('message_stop', {}); response.end();
})().catch(error => { providerError = error; response.destroy(); }); });
async function connect() {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`), client = { ws, events: [], state: undefined, send: value => ws.send(JSON.stringify(value)) };
	clients.push(client);
	ws.on('message', raw => { const event = JSON.parse(raw); client.events.push(event); client.state = mergeSnapshot(client.state, event); });
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	client.send({ type: 'hello', clientId: 'snapshot', protocolVersion: PROTOCOL_VERSION });
	await wait(() => client.events.some(event => event.type === 'ready'), 'ready');
	assert.equal(client.events.find(event => event.type.startsWith('snapshot')).type, 'snapshot', 'every new connection starts with a full baseline');
	return client;
}
async function full(client) {
	const start = client.events.length; client.send({ type: 'get_state' });
	await wait(() => client.events.slice(start).some(event => event.type === 'snapshot'), 'forced full snapshot');
	return client.events.slice(start).find(event => event.type === 'snapshot');
}
async function context(client, requestId) {
	const previous = client.state.commandOutputs.length, start = client.events.length;
	client.send({ type: 'prompt', text: '/context', requestId });
	await wait(() => client.state.commandOutputs.length > previous && client.events.slice(start).some(event => event.type === 'prompt_result' && event.requestId === requestId), 'native command output');
	return client.events.slice(start);
}
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 1000000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false } }));
	const env = testEnv({ PI_WEB_CWD: root, PI_WEB_DATA_DIR: data });
	for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
	harness = await startIsolatedHarness({ env });
	const client = await connect();
	await full(client);
	assert((await context(client, 'local-before')).some(event => event.type === 'snapshot_delta'), 'native local changes must emit lightweight deltas');
	const originalId = client.state.conversationId;
	client.send({ type: 'prompt', text: 'Read fixture.txt and explain.', requestId: 'tool-round' });
	await wait(() => release && client.state.streamingMessage && client.state.messages.some(message => message.role === 'toolResult'), 'native tool and streamed reply');
	const tool = client.state.messages.find(message => message.role === 'toolResult');
	assert(!tool.isError && JSON.stringify(tool.content).includes('Native snapshot tool output'), 'the fixture must execute the real read tool');
	assert(tool.toolOutputUrl?.includes('fixture-read'));
	assert(client.events.some(event => event.type === 'snapshot_delta' && event.appended.some(message => message.role === 'toolResult')), 'real tool results arrive as appended history');
	const start = client.events.length;
	release(); await wait(() => finish && JSON.stringify(client.state.streamingMessage).includes('Second streamed fragment'), 'second streaming checkpoint');
	const streaming = client.events.slice(start).filter(event => event.type.startsWith('snapshot'));
	assert(streaming.length > 0 && streaming.every(event => event.type === 'snapshot_delta'), 'streaming over tool history must not retransmit the transcript');
	assert(streaming.every(event => event.appended.length === 0 && !('messages' in event.state)));
	const second = await connect();
	assert.equal(second.state.conversationId, originalId);
	assert.equal(second.state.messages.find(message => message.role === 'toolResult').toolOutputUrl, tool.toolOutputUrl);
	finish(); await wait(() => !client.state.isStreaming && client.state.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('Second streamed fragment')), 'task settled');
	const baseline = await full(client);
	// Drop one real delta as a slow receiver might; the next must detect a gap.
	const dropped = await context(client, 'dropped');
	const next = await context(client, 'after-drop');
	assert(dropped.some(event => event.type === 'snapshot_delta'));
	const nextDelta = next.find(event => event.type === 'snapshot_delta'); assert(nextDelta);
	assert.throws(() => mergeSnapshot(baseline.state, nextDelta), /revision gap/);
	const resynced = await full(client);
	assert(resynced.state.commandOutputs.some(output => output.id === client.state.commandOutputs.at(-1).id));
	client.send({ type: 'new_chat' });
	await wait(() => client.state.conversationId !== originalId && !client.state.isStreaming, 'new conversation');
	assert(client.events.some(event => event.type === 'snapshot' && event.state.conversationId === client.state.conversationId && event.state.messages.length === 0));
	client.send({ type: 'switch_conversation', id: originalId });
	await wait(() => client.state.conversationId === originalId, 'return to tool history');
	assert(client.state.messages.some(message => message.role === 'toolResult'));
	for (const observer of clients) {
		let state;
		for (const event of observer.events) {
			if (event.type === 'snapshot' && state) assert(event.state.rev > state.rev);
			state = mergeSnapshot(state, event);
		}
		assert.deepEqual(state, observer.state, 'every received revision forms a continuous chain');
	}
	assert.equal(requests.length, 2, 'snapshot recovery and local commands never call the model');
	if (process.argv.includes('--browser')) {
		const { chromium } = await import('playwright-core');
		const { CHROME_PATH } = await import('./lib/chrome.mjs');
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const page = await browser.newPage();
		let ready = false, dropNext = false, dropped = false, resync = false;
		await page.routeWebSocket('**/ws', route => {
			const upstream = route.connectToServer();
			route.onMessage(raw => {
				if (dropped && JSON.parse(String(raw)).type === 'get_state') resync = true;
				upstream.send(raw);
			});
			upstream.onMessage(raw => {
				const event = JSON.parse(String(raw));
				if (event.type === 'ready') ready = true;
				if (event.type === 'snapshot_delta' && dropNext) { dropNext = false; dropped = true; return; }
				route.send(raw);
			});
		});
		await page.goto(`http://127.0.0.1:${harness.port}`);
		await wait(() => ready, 'browser ready');
		const input = page.locator('.inputbar textarea');
		dropNext = true;
		await input.fill('/context'); await page.locator('.composer-action.send').click();
		await wait(() => dropped, 'dropped browser delta');
		await page.waitForFunction(() => document.querySelector('.inputbar textarea')?.value === '');
		await input.fill('/context'); await page.locator('.composer-action.send').click();
		await wait(() => resync, 'browser requests a full state after revision gap');
		await page.waitForFunction(() => document.querySelectorAll('.omp-command-output').length === 2);
		assert.equal(requests.length, 2, 'browser resync does not replay prompts or call the model');
		await browser.close(); browser = undefined;
	}
	console.log('PASS OMP snapshots: full initial/get_state/reconnect/navigation, native tool appends, streaming light fields, dropped delta detection and resync, continuous multi-socket revision chains');
} finally {
	await browser?.close();
	release?.(); finish?.(); for (const client of clients) client.ws.terminate();
	await harness?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
