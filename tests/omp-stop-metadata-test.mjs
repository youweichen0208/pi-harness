import { mergeSnapshot } from "./lib/snapshots.mjs";
/** Passive metadata and reconnect must not revive a stopped native worker. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ompTestExecutable, ompTestRoot, ompTestPackaged } from './lib/omp-runtime-location.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
const root = mkdtempSync(join(tmpdir(), 'omp-stop-metadata-')), agent = join(root, 'data/omp/agent'), cwd = join(root, 'workspace');
mkdirSync(agent, { recursive: true }); mkdirSync(cwd);
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false } }));
writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'fixture' }] } } }));
let harness, state; const sockets = [], messages = [], navigationResults = [], treeResults = [];
const wait = async (predicate, timeoutMs = 10000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('Stop metadata fixture timed out'); };
try {
	harness = await startIsolatedHarness({ executable: ompTestExecutable, args: [join(ompTestRoot, 'dist/server/index.js')], env: { PI_WEB_DATA_DIR: join(root, 'data'), PI_WEB_CWD: cwd, PI_WEB_PKG_ROOT: ompTestRoot, ...(ompTestPackaged ? { ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '', NODE_OPTIONS: '' } : {}) } });
	const base = `http://127.0.0.1:${harness.port}`;
	const connect = async () => { let socketState; const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`); sockets.push(socket); socket.on('message', raw => { const event = JSON.parse(raw); socketState = mergeSnapshot(socketState, event); if (socketState && (!state || socketState.rev > state.rev)) state = socketState; if (event.type === 'tree_navigate_result') navigationResults.push(event); if (event.type === 'tree') treeResults.push(event); messages.push(event.type); }); await new Promise(resolve => socket.once('open', resolve)); socket.send(JSON.stringify({ type: 'hello', clientId: 'stop-metadata' })); return socket; };
	const socket = await connect();
	// Native command updates may precede host initialization; only ready admits HTTP operations.
	try { await wait(() => messages.includes('ready') && messages.includes('slash_commands'), 40000); }
	catch (error) { throw Error(`${error.message}; received: ${messages.join(', ')}; server: ${harness.logs}`); }
	const status = async () => (await fetch(`${base}/api/omp-mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ clientId: 'stop-metadata', cwd: state.cwd, conversationId: state.conversationId, action: 'status' }) })).json();
	assert.equal((await status()).available, true);
	socket.send(JSON.stringify({ type: 'abort' })); await wait(async () => (await status()).available === false);
	socket.send(JSON.stringify({ type: 'tree_get', conversationId: state.conversationId, reqId: 'stopped-tree', filter: 'all' }));
	await wait(() => treeResults.some(result => result.reqId === 'stopped-tree'));
	assert.equal((await status()).available, false, 'reading the tree must not reopen a stopped worker');
	const historyBeforeTree = state.sessionFile && existsSync(state.sessionFile) ? readFileSync(state.sessionFile) : undefined;
	socket.send(JSON.stringify({ type: 'tree_get', conversationId: state.conversationId, reqId: 'stopped-tree-again', filter: 'user-only', query: 'unmatched' }));
	await wait(() => treeResults.some(result => result.reqId === 'stopped-tree-again'));
	if (historyBeforeTree) assert.deepEqual(readFileSync(state.sessionFile), historyBeforeTree, 'passive tree read must not rewrite history');
	// Minimal reproduction: get_settings alone used to call command() -> open().
	socket.send(JSON.stringify({ type: 'get_settings' }));
	for (let i = 0; i < 50; i++) { await new Promise(resolve => setTimeout(resolve, 100)); assert.equal((await status()).available, false, 'get_settings must not reopen a stopped worker'); }
	for (const type of ['get_commands', 'list_sessions', 'get_state']) socket.send(JSON.stringify({ type }));
	await connect();
	for (let i = 0; i < 50; i++) { await new Promise(resolve => setTimeout(resolve, 100)); assert.equal((await status()).available, false, 'reconnect/metadata must not reopen a stopped worker'); }
	const api = (path, action, payload = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ clientId: 'stop-metadata', cwd: state.cwd, conversationId: state.conversationId, action, ...payload }) });
	assert.equal((await (await api('/api/extensions', 'omp-resources')).json()).available, false);
	assert.equal((await (await api('/api/omp-extensions', 'get')).json()).available, false);
	assert.equal((await (await api('/api/omp-mcp', 'get', { scope: 'global' })).json()).available, false);
	assert.equal((await api('/api/omp-mcp', 'save', { scope: 'global', version: 'stale', document: {} })).status, 400);
	assert.equal((await api('/api/extensions', 'omp-save-skills', { version: 'stale', patch: { enabled: true } })).status, 400);
	assert.equal((await status()).available, false);
	// Stop must revoke an explicit reload even while native module initialization is pending.
	const originalSessionId = state.sessionId, imported = join(root, 'reload-imports.txt');
	mkdirSync(join(agent, 'extensions'));
	writeFileSync(join(agent, 'extensions/slow-reload.js'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(imported)}, 'imported\\n'); await new Promise(resolve => setTimeout(resolve, 2000)); export default api => api.on('session_start', () => {});`);
	const restarting = api('/api/omp-extensions', 'restart');
	await wait(() => existsSync(imported), 40000);
	socket.send(JSON.stringify({ type: 'abort' }));
	assert.equal((await restarting).status, 400, 'Stop cancels the pending reload');
	await wait(async () => (await status()).available === false);
	await api('/api/extensions', 'omp-resources'); await api('/api/omp-extensions', 'get');
	await new Promise(resolve => setTimeout(resolve, 3000));
	assert.equal((await status()).available, false);
	socket.send(JSON.stringify({ type: 'tree_get', conversationId: state.conversationId, reqId: 'stopped-tree-with-extension', filter: 'all', query: 'unmatched' }));
	await wait(() => treeResults.some(result => result.reqId === 'stopped-tree-with-extension'));
	assert.equal((await status()).available, false);
	assert.equal(readFileSync(imported, 'utf8'), 'imported\n', 'passive reads cannot re-import the stopped extension');
	const restarted = await api('/api/omp-extensions', 'restart'); assert.equal(restarted.status, 200);
	assert.equal((await restarted.json()).available, true); assert.equal(state.sessionId, originalSessionId);
	assert.equal(readFileSync(imported, 'utf8'), 'imported\nimported\n', 'a later explicit reload may reopen the same history');
	const beforeReopen = readFileSync(imported, 'utf8');
	socket.send(JSON.stringify({ type: 'session_reopen', conversationId: state.conversationId, reqId: 'cancelled-reopen' }));
	await wait(() => readFileSync(imported, 'utf8').length > beforeReopen.length, 40000);
	socket.send(JSON.stringify({ type: 'abort' }));
	await wait(() => navigationResults.some(result => result.reqId === 'cancelled-reopen'));
	assert(!navigationResults.some(result => result.reqId === 'cancelled-reopen' && result.status === 'ok'));
	await wait(async () => (await status()).available === false);
	await api('/api/extensions', 'omp-resources');
	assert.equal((await status()).available, false, 'cancelled history reopen stays stopped');
	console.log('PASS stopped OMP worker stays closed during metadata/resource/reconnect reads; Stop cancels extension restart and history reopen; explicit reload preserves session identity');
} finally { for (const socket of sockets) socket.terminate(); await harness?.stop(); rmSync(root, { recursive: true, force: true }); }
