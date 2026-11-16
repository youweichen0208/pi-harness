import { mergeSnapshot } from "./lib/snapshots.mjs";
/** Exercise the production /ws entry, with a real OMP worker and a local provider. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { once } from 'node:events';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { ompTestRoot, ompTestExecutable, ompTestPackaged } from './lib/omp-runtime-location.mjs';
const root = mkdtempSync(join(tmpdir(), 'omp-entry-'));
const data = join(root, 'data'), cwd = join(root, 'project'), agent = join(data, 'omp', 'agent'), legacy = join(root, 'pi');
for (const path of [agent, cwd, legacy]) mkdirSync(path, { recursive: true });
writeFileSync(join(legacy, 'models.json'), 'INVALID_PI_CONFIGURATION_MUST_NOT_BE_LOADED');
writeFileSync(join(cwd, 'fixture.txt'), 'OMP_ENTRY_READ_VERIFIED');
const requests = [];
const mock = createServer(async (req, res) => {
	if (req.method === 'GET' && req.url === '/models') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ data: [{ id: 'fixture' }, { id: 'discovered-entry', max_output_tokens: 12345 }] })); return;
	}
	let raw = ''; for await (const chunk of req) raw += chunk;
	const payload = JSON.parse(raw); requests.push(payload);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `m-${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
	const last = JSON.stringify(payload.messages.at(-1)?.content);
	if (last.includes('HANG_ENTRY')) return;
	const read = last.includes('READ_ENTRY');
	emit('content_block_start', { index: 0, content_block: read ? { type: 'tool_use', id: 'read-1', name: 'read', input: {} } : { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: read ? { type: 'input_json_delta', partial_json: '{"path":"fixture.txt"}' } : { type: 'text_delta', text: 'OMP_ENTRY_DONE' } });
	emit('content_block_stop', { index: 0 });
	emit('message_delta', { delta: { stop_reason: read ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
	emit('message_stop', {}); res.end();
});
let harness, socket, state, earlyScmSent = false;
const events = [];
const wait = async (test, label) => {
	for (let i = 0; i < 800; i++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
	throw Error(`Timed out ${label}: ${JSON.stringify(events.slice(-4))}\n${harness?.logs}`);
};
const send = value => socket.send(JSON.stringify(value));
const prompt = (text, requestId = crypto.randomUUID()) => send({ type: 'prompt', text, requestId, target: { cwd: state.cwd, conversationId: state.conversationId, sessionId: state.sessionId } });
try {
	const port = await listenIsolated(mock);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'SECRET_FIXTURE_KEY', models: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	harness = await startIsolatedHarness({ executable: ompTestExecutable, args: [join(ompTestRoot, 'dist/server/index.js')], env: {
		PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: legacy, PI_WEB_PKG_ROOT: ompTestRoot,
		...(ompTestPackaged ? { ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '', NODE_OPTIONS: '' } : {}),
	} });
	const health = await (await fetch(`http://127.0.0.1:${harness.port}/api/health`)).json();
	assert.equal(health.agentEngine, 'omp');
	socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	const receive = raw => {
		const event = JSON.parse(raw); events.push(event);
		state = mergeSnapshot(state, event);
		if (event.type === 'snapshot' || event.type === 'snapshot_delta') {
			if (!earlyScmSent && !events.some(event => event.type === 'ready')) {
				earlyScmSent = true; send({ type: 'scm_status', reqId: -101 });
			}
		}
	};
	socket.on('message', receive);
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
	send({ type: 'hello', clientId: 'omp-entry' }); await wait(() => state && events.some(event => event.type === 'ready'), 'initial snapshot');
	assert(earlyScmSent, 'fixture must query SCM during worker initialization');
	await wait(() => events.some(event => event.type === 'scm_data' && event.reqId === -101 && event.ok), 'SCM request buffered before ready');
	assert(state.tools.includes('task') && state.tools.includes('read'));
	assert(!state.tools.includes('subagent') && !state.tools.includes('codemode'));
	assert.deepEqual(state.runSettings, { autoCompaction: false, autoRetry: false });
	send({ type: 'set_run_settings', conversationId: 'not-current', autoRetry: true });
	await wait(() => events.some(e => e.type === 'notice' && e.text === 'Conversation changed'), 'wrong conversation settings rejected');
	assert.equal(state.runSettings.autoRetry, false);
	send({ type: 'set_run_settings', conversationId: state.conversationId, autoRetry: true });
	await wait(() => state.runSettings.autoRetry, 'native run settings snapshot');
	const promptResponse = await fetch(`http://127.0.0.1:${harness.port}/api/system-prompt`, {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${harness.port}` },
		body: JSON.stringify({ clientId: 'omp-entry', cwd: state.cwd, conversationId: state.conversationId, action: 'get' }),
	});
	assert.equal(promptResponse.status, 200);
	const nativePrompt = await promptResponse.json();
	assert(nativePrompt.available && nativePrompt.blocks.join('\n\n').trim().length > 0, 'Native OMP prompt blocks must be visible in settings');
	await wait(() => events.some(event => event.type === 'settings_state' && event.settings.effectiveSystemPrompt === nativePrompt.blocks.join('\n\n')), 'native prompt in settings');
	send({ type: 'set_model', modelId: 'fixture/fixture' }); await wait(() => state.model?.id === 'fixture', 'model selection');
	prompt('READ_ENTRY', 'read-entry-request');
	await wait(() => !state.isStreaming && state.messages.some(m => m.role === 'assistant' && m.content.some(b => b.text === 'OMP_ENTRY_DONE')), 'native tool completion');
	await wait(() => events.some(event => event.type === 'prompt_result' && event.requestId === 'read-entry-request' && event.receipt === 'accepted'), 'accepted receipt');
	const afterRead = requests.length; prompt('READ_ENTRY', 'read-entry-request');
	await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(requests.length, afterRead);
	assert(requests.some(request => JSON.stringify(request.messages).includes('OMP_ENTRY_READ_VERIFIED')));
	assert(requests.every(request => request.max_tokens === 16384));
	const first = state.conversationId, file = state.sessionFile;
	prompt('HANG_ENTRY'); await wait(() => state.isStreaming && requests.at(-1)?.messages.some(m => JSON.stringify(m.content).includes('HANG_ENTRY')), 'hanging first conversation');
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR6sAAAAASUVORK5CYII=';
	for (const requestId of ['queued-a', 'queued-b']) send({ type: 'prompt', text: 'QUEUED_IMAGE', queue: 'followUp', requestId,
		attachments: [{ path: 'pixel.png', imageData: image, mimeType: 'image/png' }], target: { cwd: state.cwd, conversationId: first, sessionId: state.sessionId } });
	await wait(() => ['queued-a', 'queued-b'].every(id => events.some(e => e.type === 'prompt_result' && e.requestId === id && e.receipt === 'accepted')), 'two queued image prompts');
	const beforeRecall = requests.length;
	const recall = { type: 'recall_queue', conversationId: first, requestId: 'recall-images' };
	send(recall); send(recall);
	await wait(() => events.some(e => e.type === 'queue_recalled' && e.requestId === recall.requestId), 'queue recall');
	const recalled = events.find(e => e.type === 'queue_recalled' && e.requestId === recall.requestId);
	assert.equal(recalled.text.match(/QUEUED_IMAGE/g)?.length, 2);
	assert.equal(recalled.images.length, 2);
	assert.deepEqual(recalled.images[0], recalled.images[1], 'duplicate images are both restored');
	// OMP normalizes queued images itself; restore that native representation.
	assert.equal(recalled.images[0].mimeType, 'image/webp');
	const restoredImage = Buffer.from(recalled.images[0].data, 'base64');
	assert.equal(restoredImage.subarray(0, 4).toString(), 'RIFF');
	assert.equal(restoredImage.subarray(8, 12).toString(), 'WEBP');
	await wait(() => state.queue.followUp.length === 0, 'empty native queue after recall');
	assert(state.isStreaming, 'recall must not abort the current response'); assert.equal(requests.length, beforeRecall);
	const close = once(socket, 'close'); socket.close(); await close;
	const replayStart = events.length;
	socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`); socket.on('message', receive);
	await once(socket, 'open'); send({ type: 'hello', clientId: 'omp-entry' });
	await wait(() => events.slice(replayStart).some(e => e.type === 'queue_recalled' && e.requestId === recall.requestId), 'unacknowledged queue replay after reconnect');
	send({ type: 'prompt', text: 'NEXT_QUEUE', queue: 'followUp', requestId: 'queue-next' });
	await wait(() => state.queue.followUp.includes('NEXT_QUEUE'), 'next queue admitted');
	send(recall);
	send({ type: 'queue_recall_ack', conversationId: first, requestId: recall.requestId });
	send(recall); // A late retry after acknowledgement must not withdraw new input.
	send({ type: 'get_state' }); await new Promise(resolve => setTimeout(resolve, 150));
	assert(state.queue.followUp.includes('NEXT_QUEUE'));
	send({ type: 'recall_queue', conversationId: first, requestId: 'recall-next' });
	await wait(() => events.some(e => e.type === 'queue_recalled' && e.requestId === 'recall-next' && e.text === 'NEXT_QUEUE'), 'next queue explicitly recalled');
	send({ type: 'queue_recall_ack', conversationId: first, requestId: 'recall-next' });
	assert.equal(requests.length, beforeRecall, 'queued drafts must not reach the model');
	send({ type: 'prompt', text: 'BACKGROUND_QUEUE', queue: 'followUp', requestId: 'queue-background' });
	await wait(() => state.queue.followUp.includes('BACKGROUND_QUEUE'), 'background queue admitted');
	send({ type: 'new_chat' }); await wait(() => state.conversationId !== first && !state.isStreaming, 'independent conversation');
	assert.equal(state.runSettings.autoRetry, false, 'new conversation inherits native config');
	const beforeBackgroundRecall = events.length;
	send({ type: 'recall_queue', conversationId: first, requestId: 'recall-background' });
	await wait(() => events.slice(beforeBackgroundRecall).some(e => e.type === 'notice' && e.text === 'Conversation changed'), 'background recall rejected');
	prompt('Independent conversation'); await wait(() => !state.isStreaming && state.messages.some(m => m.content.some(b => b.text === 'OMP_ENTRY_DONE')), 'second completion');
	send({ type: 'switch_conversation', id: first }); await wait(() => state.conversationId === first && state.isStreaming, 'first remains running');
	assert.equal(state.runSettings.autoRetry, true, 'existing conversation keeps its override');
	assert(state.queue.followUp.includes('BACKGROUND_QUEUE'), 'inactive conversation queue was not touched');
	send({ type: 'recall_queue', conversationId: first, requestId: 'recall-background' });
	await wait(() => events.some(e => e.type === 'queue_recalled' && e.requestId === 'recall-background' && e.text === 'BACKGROUND_QUEUE'), 'owning conversation recall');
	send({ type: 'queue_recall_ack', conversationId: first, requestId: 'recall-background' });
	send({ type: 'abort' }); await wait(() => !state.isStreaming, 'stop');
	const stoppedCount = requests.length;
	send({ type: 'get_state' }); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(requests.length, stoppedCount);
	prompt('Explicit continuation'); await wait(() => !state.isStreaming && requests.length > stoppedCount, 'manual continuation');
	assert(!requests.some(request => /QUEUED_IMAGE|NEXT_QUEUE|BACKGROUND_QUEUE/.test(JSON.stringify(request.messages))), 'withdrawn prompts never leak into later model history');
	assert.equal(state.sessionFile, file);
	send({ type: 'list_models_config' }); await wait(() => events.some(event => event.type === 'models_config'), 'OMP config');
	for (const [request, responseType] of [
		[{ type: 'fetch_models', reqId: 201, baseUrl: `http://127.0.0.1:${port}`, api: 'anthropic-messages', apiKey: 'DRAFT_ENTRY_SECRET' }, 'fetch_models_result'],
		[{ type: 'refresh_provider_models', reqId: 202, providerId: 'fixture' }, 'refresh_provider_result'],
		[{ type: 'clone_provider', reqId: 203, provider: 'anthropic' }, 'clone_provider_result'],
	]) {
		send(request);
		await wait(() => events.some(event => event.type === responseType && event.reqId === request.reqId), responseType);
		assert.equal(events.find(event => event.type === responseType && event.reqId === request.reqId).ok, true);
	}
	assert.equal(events.find(event => event.type === 'refresh_provider_result' && event.reqId === 202).added, 1);
	assert(!JSON.stringify(events).includes('DRAFT_ENTRY_SECRET'));
	assert(!JSON.stringify(events).includes('SECRET_FIXTURE_KEY'));
	assert(state.sessionFile.includes('/omp/sessions/'));
	send({ type: 'tree_get', conversationId: first, reqId: 'native-tree', filter: 'all' });
	await wait(() => events.some(event => event.type === 'tree' && event.reqId === 'native-tree'), 'native tree');
	assert(events.find(event => event.type === 'tree' && event.reqId === 'native-tree').nodes.some(node => node.kind === 'user'));
	const resourceResponse = await fetch(`http://127.0.0.1:${harness.port}/api/extensions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${harness.port}` }, body: JSON.stringify({ clientId: 'omp-entry', cwd: state.cwd, conversationId: first, action: 'omp-resources' }) });
	assert.equal(resourceResponse.status, 200); const resources = await resourceResponse.json();
	assert(resources.tools.includes('task')); assert(resources.agentDir.endsWith('/omp/agent'));
	assert(!JSON.stringify(resources).includes('SECRET_FIXTURE_KEY'));
	const authEvents = events.length;
	send({ type: 'set_provider_api_key', provider: 'anthropic', apiKey: 'NATIVE_STORED_SECRET' });
	await wait(() => events.slice(authEvents).some(event => event.type === 'providers_status' && event.providers.some(provider => provider.id === 'anthropic' && provider.source === 'stored')), 'native stored key status');
	const clearEvents = events.length;
	send({ type: 'clear_provider_api_key', provider: 'anthropic' });
	await wait(() => events.slice(clearEvents).some(event => event.type === 'providers_status' && event.providers.some(provider => provider.id === 'anthropic' && provider.source !== 'stored')), 'native cleared key status');
	assert(!JSON.stringify(events).includes('NATIVE_STORED_SECRET'));
	const loginStart = events.length, requestsBeforeLogin = requests.length;
	send({ type: 'login_provider', provider: 'unavailable-fixture' });
	await wait(() => events.slice(loginStart).some(event => event.type === 'provider_auth' && event.state.phase === 'error'), 'native unavailable login');
	assert.equal(requests.length, requestsBeforeLogin, 'Authentication worker must not invoke a model');
	assert.equal(state.conversationId, first, 'Authentication must not replace the chat');
	console.log('PASS production OMP entry: native tools, native default output limit, receipts, conversation isolation, stop and continuation; invalid Pi config ignored');
} finally { socket?.close(); await harness?.stop(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); rmSync(root, { recursive: true, force: true }); }
