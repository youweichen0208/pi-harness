/** Real Bun + OMP SDK over a local Anthropic SSE fixture. No external credentials or paid calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadOmpTestModule } from './lib/omp-runtime-location.mjs';
const { OmpSession } = await loadOmpTestModule('session.js');
const { OmpHostTools } = await loadOmpTestModule('host-tools.js');
const { createOmpRuntime, stopOmpRuntime } = await loadOmpTestModule('runtime.js');
import { listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';

const root = mkdtempSync(join(tmpdir(), 'omp-runtime-'));
const dataDir = join(root, 'data'), cwd = join(root, 'project'), home = join(root, 'home');
const agent = join(dataDir, 'omp', 'agent');
for (const p of [agent, cwd, home]) mkdirSync(p, { recursive: true });
const requests = [], processes = new Set();
const mock = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	const payload = JSON.parse(raw); requests.push(payload);
	const last = payload.messages.at(-1);
	const text = JSON.stringify(last?.content);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event('message_start', { message: { id: `m-${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
	if (text.includes('HANG_FIXTURE')) return; // An abort must close this stream.
	if (text.includes('USE_HOST_TOOL') || text.includes('READ_FILE_FIXTURE') || text.includes('ASYNC_FIXTURE')) {
		event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'host-1', name: text.includes('ASYNC_FIXTURE') ? 'bash' : text.includes('READ_FILE_FIXTURE') ? 'read' : 'fixture_echo', input: {} } });
		for (const part of (text.includes('ASYNC_FIXTURE') ? [JSON.stringify({ command: text.includes('CANCEL_ASYNC_FIXTURE') ? 'sleep 30; echo SHOULD_NOT_FINISH' : 'sleep 2; echo NATIVE_BG', async: true, pty: false })] : text.includes('READ_FILE_FIXTURE') ? ['{"path":"fixture.txt"}'] : ['{"text":', '"汉字', '🙂"}'])) event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: part } });
		event('content_block_stop', { index: 0 });
		event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } });
	} else {
		event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
		event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'FIXTURE_DONE' } });
		event('content_block_stop', { index: 0 });
		event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
	}
	event('message_stop', {}); res.end();
});
async function wait(test, label) {
	for (let i = 0; i < 400; i++) { if (test()) return; await sleep(25); }
	throw Error(`Timed out: ${label}`);
}
const events = [], errors = [];
let hostBridge; let hostCalls = 0;
const env = testEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share') });
for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|^ANTHROPIC_|^OPENAI_|^BUN_OPTIONS$|^NODE_OPTIONS$/.test(key)) delete env[key];
const open = async (id, sessionFile) => {
	const runtime = await createOmpRuntime({ conversationId: id, dataDir, cwd, env, sessionFile, model: 'fixture/fixture', thinking: 'off',
		restricted: { systemPrompt: 'Use only supplied tools. Do not delegate.', toolNames: ['fixture_echo'] },
		onEvent: e => { events.push(e); hostBridge?.observe(e); }, onExit: e => errors.push(e) });
	processes.add(runtime);
	await runtime.request('set_session_name', { name: 'Fixture' });
	return runtime;
};
try {
	const port = await listenIsolated(mock);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture-only', models: [{ id: 'fixture', name: 'Fixture', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 128000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	writeFileSync(join(cwd, 'fixture.txt'), 'NATIVE_READ_VERIFIED');
	const native = await createOmpRuntime({ conversationId: 'native', dataDir, cwd, env, model: 'fixture/fixture', thinking: 'off', onEvent: e => events.push(e), onExit: e => errors.push(e) });
	processes.add(native);
	await native.request('set_session_name', { name: 'Native fixture' });
	const nativeState = (await native.request('get_state')).data;
	assert(nativeState.dumpTools.some(t => t.name === 'read'), 'normal profile retains native tools');
	assert(nativeState.dumpTools.some(t => t.name === 'task'), 'normal profile retains native task tool');
	await native.request('prompt', { message: 'READ_FILE_FIXTURE' });
	await wait(() => events.some(e => e.conversationId === 'native' && e.frame.type === 'session_settled'), 'native file tool completion');
	assert(requests.some(r => JSON.stringify(r.messages).includes('NATIVE_READ_VERIFIED')), 'real native read output reaches model');
	events.length = 0;
	await native.request('prompt', { message: 'ASYNC_FIXTURE' });
	await wait(() => events.some(e => e.conversationId === 'native' && e.frame.type === 'prompt_result'), 'background turn yields');
	const yielded = events.find(e => e.conversationId === 'native' && e.frame.type === 'prompt_result').frame;
	assert.equal(yielded.sessionSettled, false, 'background command keeps session running after model yields');
	assert.equal(native.isBusy, true);
	await wait(() => events.some(e => e.conversationId === 'native' && e.frame.type === 'session_settled'), 'background delivery settles');
	assert.equal(native.isBusy, false);
	events.length = 0;
	await native.request('prompt', { message: 'CANCEL_ASYNC_FIXTURE' });
	await wait(() => events.some(e => e.frame.type === 'prompt_result'), 'cancellable background turn yields');
	assert.equal(events.find(e => e.frame.type === 'prompt_result').frame.sessionSettled, false);
	const nativeFile = (await native.request('get_state')).data.sessionFile;
	await stopOmpRuntime(native); processes.delete(native);
	const requestsAfterStop = requests.length;
	const reopenedNative = await createOmpRuntime({ conversationId: 'native-reopened', dataDir, cwd, env, sessionFile: nativeFile, model: 'fixture/fixture', thinking: 'off', onEvent: e => events.push(e), onExit: e => errors.push(e) });
	processes.add(reopenedNative);
	const reopenedState = (await reopenedNative.request('get_state')).data;
	assert.equal(reopenedState.hasPendingAsyncWork, false, 'closed generation cannot revive cancelled background work');
	assert.equal(reopenedState.isSettled, true);
	assert.equal(requests.length, requestsAfterStop, 'restoring does not automatically resubmit');
	await reopenedNative.close(); processes.delete(reopenedNative); events.length = 0;
	const first = await open('first');
	const state = (await first.request('get_state')).data;
	assert.equal(state.model.id, 'fixture');
	assert.equal(state.model.maxTokens, 128000);
	assert(!state.dumpTools.some(t => ['bash', 'read', 'task'].includes(t.name)), 'restricted session must not expose local tools');
	hostBridge = new OmpHostTools('first', [{ name: 'fixture_echo', description: 'Return text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, async execute(args, context) { hostCalls++; assert.deepEqual(args, { text: '汉字🙂' }); assert.equal(context.conversationId, 'first'); return { content: [{ type: 'text', text: 'host success' }] }; } }]);
	await hostBridge.bind(first);
	await first.request('prompt', { message: 'USE_HOST_TOOL' });
	await wait(() => events.some(e => e.frame.type === 'session_settled'), 'tool round settlement');
	assert.equal(first.isBusy, false);
	const call = events.find(e => e.frame.type === 'host_tool_call');
	hostBridge.observe(call); hostBridge.observe({ ...call, generation: 'stale' });
	await sleep(20); assert.equal(hostCalls, 1, 'duplicate/stale events never execute twice');
	assert(requests.some(r => JSON.stringify(r.messages).includes('host success')), 'tool result returns to provider');
	assert(requests.every(r => r.model === 'fixture'), 'no silent model substitution');
	assert(requests.every(r => r.max_tokens === 128000), 'actual provider request retains 128000');
	const sessionFile = (await first.request('get_state')).data.sessionFile;
	hostBridge.close();
	await first.close(); processes.delete(first);
	const restored = await open('restored', sessionFile);
	const messages = (await restored.request('get_messages')).data.messages;
	assert(JSON.stringify(messages).includes('FIXTURE_DONE'), 'native history resumes');
	const second = await open('second');
	events.length = 0;
	await restored.request('prompt', { message: 'HANG_FIXTURE' });
	await wait(() => restored.isBusy && requests.at(-1)?.messages.some(m => JSON.stringify(m.content).includes('HANG_FIXTURE')), 'active stream');
	await restored.request('follow_up', { message: 'MUST_NOT_RUN' });
	await second.request('prompt', { message: 'independent conversation' });
	await wait(() => events.some(e => e.conversationId === 'second' && e.frame.type === 'session_settled'), 'second conversation completes independently');
	await restored.request('abort_and_restore_queue');
	await wait(() => events.some(e => e.conversationId === 'restored' && e.frame.type === 'session_settled'), 'abort settles');
	assert(!requests.some(r => JSON.stringify(r.messages).includes('MUST_NOT_RUN')), 'stop withdraws queued work');
	assert.equal((await restored.request('get_state')).data.isSettled, true);
	assert.equal((await second.request('get_state')).data.isSettled, true);
	await restored.request('prompt', { message: 'continue after interruption' });
	await wait(() => events.filter(e => e.conversationId === 'restored' && e.frame.type === 'session_settled').length >= 2, 'manual continuation');
	const product = new OmpSession({ conversationId: 'product', dataDir, cwd, env, model: 'fixture/fixture', thinking: 'off',
		restricted: { systemPrompt: 'Answer the user.', toolNames: [] }, onChange() {} });
	try {
		await product.open();
		await product.prompt('Product conversation');
		await wait(() => !product.state.running && product.state.messages.some(m => m.content.some(b => b.text === 'FIXTURE_DONE')), 'product state settlement');
		const firstFile = product.state.sessionFile;
		const beforeHang = requests.length;
		await product.prompt('HANG_FIXTURE');
		await wait(() => requests.length > beforeHang, 'product hang');
		const pendingAdmission = Promise.allSettled([
			product.submit('MUST_NOT_RUN_AFTER_STOP_A', [], 'followUp'),
			product.submit('MUST_NOT_RUN_AFTER_STOP_B', [], 'followUp'),
		]);
		await product.stop();
		assert((await pendingAdmission).every(result => result.status === 'rejected'), 'Stop cancels input waiting for admission');
		assert(product.state.interrupted);
		assert(!product.state.running);
		const afterStop = requests.length;
		await product.open();
		assert.equal(requests.length, afterStop, 'product reopen must not replay');
		assert(!requests.some(request => JSON.stringify(request.messages).includes('MUST_NOT_RUN_AFTER_STOP')), 'cancelled admissions never reach the provider');
		assert.equal(realpathSync(product.state.sessionFile), realpathSync(firstFile), 'product stop preserves native history file');
		await product.prompt('Explicit continuation');
		await wait(() => !product.state.running, 'product continuation');
		assert(!product.state.interrupted);
		assert(product.state.messages.some(m => m.role === 'user' && m.content.some(b => b.text === 'Product conversation')));
		assert(product.state.historyBytes > 0);
	} finally { await product.close(); }
	assert.deepEqual(errors, []);
	console.log('PASS OMP SDK: native read and background settlement, isolated host tools, streamed arguments, 128000 wire budget, restore, cancel queue, conversation isolation and manual continuation');
} finally {
	await Promise.all([...processes].map(p => p.close()));
	mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
