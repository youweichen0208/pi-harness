/** Production HTTP prompt contract with real OMP and a local streaming provider.
 * Replaces Pi APPEND_SYSTEM/automatic-reload expectations; preserves host guards.
 * Browser coverage lives in omp-prompt-browser-test.mjs, native source/CAS details
 * in omp-prompt-test.mjs. All three remain independent executable regressions. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { mergeSnapshot } from './lib/snapshots.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-prompt-http-')));
const cwd = join(root, 'work'), data = join(root, 'data'), agent = join(data, 'omp/agent');
for (const dir of [cwd, agent, join(cwd, '.pi')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(cwd, 'AGENTS.md'), 'HTTP_CONTEXT_SENTINEL');
writeFileSync(join(agent, 'SYSTEM.md'), 'HTTP_PERSONAL_SYSTEM');
writeFileSync(join(cwd, '.pi/APPEND_SYSTEM.md'), 'LEGACY_PI_APPEND_NOT_SELECTED');
mkdirSync(join(agent, 'extensions'));
writeFileSync(join(agent, 'extensions/forced.js'), `export default api => { api.on('before_agent_start', event => event.prompt === 'FORCED_HTTP_RUN' ? { systemPrompt: ['HTTP_EXTENSION_OVERRIDE'] } : undefined); };`);
const requests = []; let harness, socket, state, hold = false, release;
const events = [], clientId = 'omp-prompt-http', token = 'prompt-fixture-only';
const model = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	requests.push(JSON.parse(raw));
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
	emit({ content: `HTTP_REPLY_${requests.length}` });
	if (hold) await new Promise(resolve => { release = resolve; });
	emit({}, 'stop'); res.end('data: [DONE]\n\n');
});
const wait = async (fn, label) => {
	for (let i = 0; i < 1000; i++) { if (await fn()) return; await sleep(25); }
	throw Error(`Timed out ${label}\n${harness?.logs}`);
};
const send = message => socket.send(JSON.stringify(message));
const req = async (action, args = {}, headers = {}) => {
	const response = await fetch(`http://127.0.0.1:${harness.port}/api/system-prompt`, {
		method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
		body: JSON.stringify({ clientId, cwd, conversationId: state.conversationId, action, ...args }),
	});
	const text = await response.text(); let body;
	try { body = JSON.parse(text); } catch { body = { error: text }; }
	return { status: response.status, cache: response.headers.get('cache-control'), ...body };
};
const ok = async (action, args) => { const result = await req(action, args); assert.equal(result.status, 200, JSON.stringify(result)); return result; };
const find = (view, kind, scope) => { const file = view.files.find(f => f.kind === kind && f.scope === scope); assert(file, `${kind}:${scope}`); return file; };
const save = (file, content) => ok('save', { fileId: file.id, version: file.version, content });
const prompt = async text => {
	const count = requests.length;
	send({ type: 'prompt', text, requestId: crypto.randomUUID(), target: { cwd, conversationId: state.conversationId, sessionId: state.sessionId } });
	await wait(() => requests.length === count + 1 && state.isStreaming, 'running request');
};
try {
	const port = await listenIsolated(model);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'HTTP_FIXTURE_SECRET', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_WEB_TOKEN: token } });
	socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws?token=${token}`);
	socket.on('message', raw => { const event = JSON.parse(raw); events.push(event); state = mergeSnapshot(state, event); });
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
	send({ type: 'hello', clientId }); await wait(() => events.some(e => e.type === 'ready'), 'ready');
	if (state.model?.id !== 'fixture') send({ type: 'set_model', modelId: 'fixture/fixture' }); await wait(() => state.model?.id === 'fixture', 'model');
	const conversationId = state.conversationId, sessionId = state.sessionId;
	assert.equal((await req('get', {}, { Origin: 'https://evil.invalid' })).status, 403);
	assert.equal((await req('get', {}, { 'Content-Type': 'text/plain' })).status, 403);
	assert.equal((await req('get', {}, { Authorization: 'Bearer invalid' })).status, 401);
	for (const args of [{ cwd: root }, { conversationId: 'missing' }, { clientId: 'missing' }]) assert.equal((await req('get', args)).status, 409);
	let view = await ok('get');
	assert.equal(view.cache, 'no-store'); assert(view.available);
	assert(view.blocks.join('\n').includes('HTTP_PERSONAL_SYSTEM'));
	assert(!view.blocks.join('\n').includes('LEGACY_PI_APPEND_NOT_SELECTED'));
	assert(!JSON.stringify(view).includes('HTTP_FIXTURE_SECRET'));
	assert.equal((await req('read', { fileId: '../../models.yml' })).status, 400);
	assert.equal((await req('save', { fileId: '../../anything', version: '', content: 'BLOCKED' })).status, 400);
	let project = find(view, 'system', 'project');
	assert.equal((await req('save', { fileId: project.id, version: 'stale', content: 'BLOCKED' })).status, 400);
	view = await save(project, 'HTTP_PROJECT_SYSTEM');
	assert(view.reloadRequired); assert(view.blocks.join('\n').includes('HTTP_PERSONAL_SYSTEM'));
	assert(!view.blocks.join('\n').includes('HTTP_PROJECT_SYSTEM'));
	assert.equal((await ok('read', { fileId: project.id })).content, 'HTTP_PROJECT_SYSTEM');
	view = await ok('reload'); assert(!view.reloadRequired); assert(!view.reloadError);
	assert(view.blocks.join('\n').includes('HTTP_PROJECT_SYSTEM'));
	assert(!view.blocks.join('\n').includes('HTTP_PERSONAL_SYSTEM'));
	assert.equal(requests.length, 0, 'editing and explicit refresh never call a model');
	assert.equal(state.sessionId, sessionId); assert.equal(state.conversationId, conversationId);

	hold = true; await prompt('FIRST_HTTP_RUN');
	assert(JSON.stringify(requests[0]).includes('HTTP_PROJECT_SYSTEM'));
	project = find(await ok('get'), 'system', 'project');
	for (const action of ['save', 'delete', 'reload']) {
		const response = await req(action, { fileId: project.id, version: project.version, content: 'BUSY_MUST_NOT_SAVE' });
		assert.equal(response.status, 400); assert.match(response.error, /Stop/);
	}
	assert.equal(readFileSync(project.path, 'utf8'), 'HTTP_PROJECT_SYSTEM');
	release(); release = undefined; hold = false;
	await wait(() => !state.isStreaming, 'first settled');
	const file = state.sessionFile, before = readFileSync(file, 'utf8');
	view = await save(project, 'HTTP_CHANGED_SYSTEM');
	assert(view.reloadRequired); assert(view.blocks.join('\n').includes('HTTP_PROJECT_SYSTEM'));
	assert.equal(readFileSync(file, 'utf8'), before, 'saving alone preserves native history byte for byte');
	hold = true; await prompt('SECOND_HTTP_RUN_BEFORE_RELOAD');
	assert(JSON.stringify(requests[1]).includes('HTTP_PROJECT_SYSTEM'));
	assert(!JSON.stringify(requests[1]).includes('HTTP_CHANGED_SYSTEM'), 'a saved file is not silently activated by the next request');
	release(); release = undefined; hold = false; await wait(() => !state.isStreaming, 'second settled');
	const beforeReload = readFileSync(file, 'utf8');
	view = await ok('reload'); assert(!view.reloadError); assert(!view.reloadRequired);
	assert(view.blocks.join('\n').includes('HTTP_CHANGED_SYSTEM'));
	assert.equal(readFileSync(file, 'utf8'), beforeReload, 'explicit refresh preserves native history byte for byte');
	hold = true; await prompt('THIRD_HTTP_RUN_AFTER_RELOAD');
	assert(JSON.stringify(requests[2]).includes('HTTP_CHANGED_SYSTEM'));
	for (const text of ['FIRST_HTTP_RUN', 'SECOND_HTTP_RUN_BEFORE_RELOAD']) assert(JSON.stringify(requests[2].messages).includes(text), 'native history survives refresh');
	release(); release = undefined; hold = false; await wait(() => !state.isStreaming, 'third settled');
	assert.equal(requests.length, 3);

	project = find(await ok('get'), 'system', 'project');
	view = await ok('delete', { fileId: project.id, version: project.version });
	assert(view.reloadRequired); assert(view.blocks.join('\n').includes('HTTP_CHANGED_SYSTEM'));
	view = await ok('reload'); assert(view.blocks.join('\n').includes('HTTP_PERSONAL_SYSTEM'));
	assert.equal((await req('restore', { id: 'system:project' })).status, 400, 'retired Pi action is not silently accepted');
	hold = true; await prompt('FORCED_HTTP_RUN');
	view = await ok('get'); assert.deepEqual(view.blocks, ['HTTP_EXTENSION_OVERRIDE']);
	assert(!view.sources.some(source => source.text.includes('HTTP_PERSONAL_SYSTEM')), 'source claims must match the effective extension prompt');
	assert(JSON.stringify(requests[3]).includes('HTTP_EXTENSION_OVERRIDE'));
	release(); release = undefined; hold = false; await wait(() => !state.isStreaming, 'extension prompt settled');
	hold = true; await prompt('NORMAL_AFTER_EXTENSION_OVERRIDE');
	assert(JSON.stringify(requests[4]).includes('HTTP_PERSONAL_SYSTEM'));
	assert(!JSON.stringify(requests[4]).includes('HTTP_EXTENSION_OVERRIDE'), 'next native preparation restores the base policy');
	release(); release = undefined; hold = false; await wait(() => !state.isStreaming, 'normal prompt settled');
	send({ type: 'abort' }); await wait(async () => !(await ok('get')).available, 'stopped worker');
	// Reads wait for Stop via the tree barrier before testing exact file invariance.
	const treeId = crypto.randomUUID(); send({ type: 'tree_get', reqId: treeId, conversationId, filter: 'all' });
	await wait(() => events.some(e => e.type === 'tree' && e.reqId === treeId), 'stop completion');
	const stoppedHistory = readFileSync(file, 'utf8');
	for (const action of ['read', 'save', 'delete']) assert.equal((await req(action, { fileId: project.id, version: project.version, content: 'STOPPED_MUST_NOT_SAVE' })).status, 400);
	assert.equal((await ok('get')).available, false);
	assert.equal(readFileSync(file, 'utf8'), stoppedHistory);
	assert.equal(requests.length, 5);
	view = await ok('reload'); assert(view.available); assert(view.blocks.join('\n').includes('HTTP_PERSONAL_SYSTEM'));
	assert.equal(state.sessionId, sessionId); assert.equal(state.sessionFile, file); assert.equal(requests.length, 5);
	assert(!JSON.stringify(events).includes('HTTP_FIXTURE_SECRET'));
	console.log('PASS OMP HTTP prompt: auth/Origin/ownership, opaque file IDs/CAS, save versus explicit refresh, busy/Stop guards, native fallback, preserved history and no automatic model requests');
} finally {
	release?.(); socket?.terminate(); await harness?.stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); rmSync(root, { recursive: true, force: true });
}
if (process.argv.includes('--browser')) {
	const { spawn } = await import('node:child_process');
	const { fileURLToPath } = await import('node:url');
	const child = spawn(process.execPath, [fileURLToPath(new URL('./omp-prompt-browser-test.mjs', import.meta.url))], { stdio: 'inherit' });
	const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? signal)); });
	assert.equal(code, 0, 'native prompt browser regression');
}
