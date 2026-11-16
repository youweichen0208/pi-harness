/** Real OMP MCP config and connection lifecycle against a local HTTP fixture. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { listenIsolated } from './lib/isolated-server.mjs';
import { loadOmpTestModule, ompTestRoot } from './lib/omp-runtime-location.mjs';
import { testEnv } from './lib/test-env.mjs';
const { OmpSession } = await loadOmpTestModule('session.js');
const root = mkdtempSync(join(tmpdir(), 'omp-mcp-')), agent = join(root, 'omp/agent'), cwd = join(root, 'workspace');
mkdirSync(agent, { recursive: true }); mkdirSync(cwd);
const requests = [], sessions = [];
const fixture = createServer(async (req, res) => {
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	let raw = ''; for await (const chunk of req) raw += chunk;
	const message = JSON.parse(raw); requests.push({ path: req.url, key: req.headers.authorization, method: message.method });
	if (message.id === undefined) { res.writeHead(202); res.end(); return; }
	const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} }, instructions: 'MCP_FIXTURE_INSTRUCTIONS' }
		: message.method === 'tools/list' ? { tools: [{ name: 'fixture_echo', description: 'Echo a fixture.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
		: message.method === 'tools/call' ? { content: [{ type: 'text', text: message.params.arguments.text }] } : {};
	res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
let port;
const command = async (session, action, payload = {}) => (await session.command('harness_mcp', { action, ...payload })).data;
const get = (session, scope = 'global') => command(session, 'get', { scope });
const save = (session, view, document) => command(session, 'save', { scope: view.config.scope, version: view.config.version, document });
const wait = async predicate => { for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('MCP fixture timed out'); };
const open = async (id, restricted) => {
	const session = new OmpSession({ conversationId: id, dataDir: root, cwd, model: 'fixture/fixture', env: testEnv(), restricted, onChange() {} }); sessions.push(session); await session.open(); return session;
};
try {
	port = await listenIsolated(fixture);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', apiKey: 'MODEL_SECRET', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'fixture' }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false } }));
	const a = await open('a'), b = await open('b');
	const global = await get(a); assert.equal(global.available, true); assert.equal(global.servers.length, 0);
	const document = { privateFuture: { secret: 'ROOT_SECRET' }, mcpServers: { fixture: { type: 'http', url: `http://127.0.0.1:${port}/global?secret=URL_SECRET`, headers: { Authorization: 'Bearer MCP_SECRET' }, futureField: { value: 'UNKNOWN_SECRET' } } } };
	document.mcpServers['secret-env tools'] = { type: 'http', url: `http://127.0.0.1:${port}/never`, enabled: false, instructions: false, timeout: 10, requestIdFormat: 'string', headerPolicy: 'origin-locked', headers: { Authorization: 'NAME_SECRET' } };
	document.mcpServers['unknown-enum'] = { type: 'http', url: `http://127.0.0.1:${port}/never`, enabled: false, requestIdFormat: 'ENUM_SECRET', headerPolicy: 'ENUM_SECRET' };
	let view = await save(a, global, document);
	assert.equal(requests.length, 0, 'saving does not start processes or connect'); assert.equal(view.reloadRequired, true);
	assert.equal(view.config.document.mcpServers.fixture.headers.Authorization, '••••••••');
	const named = view.config.document.mcpServers['secret-env tools'];
	assert.deepEqual({ type: named.type, enabled: named.enabled, instructions: named.instructions, timeout: named.timeout, requestIdFormat: named.requestIdFormat, headerPolicy: named.headerPolicy }, { type: 'http', enabled: false, instructions: false, timeout: 10, requestIdFormat: 'string', headerPolicy: 'origin-locked' }, 'service names cannot mask public configuration metadata needed by the form');
	assert.equal(named.headers.Authorization, '••••••••'); assert.equal(named.url, '••••••••');
	assert.equal(view.config.document.mcpServers['unknown-enum'].requestIdFormat, '••••••••');
	assert.equal(view.config.document.mcpServers['unknown-enum'].headerPolicy, '••••••••');

	for (const secret of ['ROOT_SECRET', 'MCP_SECRET', 'URL_SECRET', 'UNKNOWN_SECRET', 'MODEL_SECRET', 'NAME_SECRET']) assert(!JSON.stringify(view).includes(secret));
	await command(a, 'reload');
	await wait(async () => (await command(a, 'status')).servers.some(server => server.name === 'fixture' && server.tools.includes('fixture_echo')));
	assert(requests.some(request => request.method === 'tools/list' && request.key === 'Bearer MCP_SECRET'));
	assert.equal((await command(b, 'status')).servers.length, 0, 'other conversation not silently reloaded');
	assert(JSON.stringify((await a.command('get_state')).data.systemPrompt).includes('MCP_FIXTURE_INSTRUCTIONS'), 'native tools refresh includes server instructions');
	view = await get(a);
	const masked = structuredClone(view.config.document); masked.mcpServers.fixture.timeout = 15000;
	await save(a, view, masked);
	const file = join(agent, 'mcp.json'), persisted = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(persisted.mcpServers.fixture.url, document.mcpServers.fixture.url);
	assert.deepEqual(persisted.privateFuture, document.privateFuture);
	await assert.rejects(save(b, view, masked), /changed/);
	view = await get(a); const beforeInvalid = readFileSync(file, 'utf8');
	for (const invalid of [{ mcpServers: { invalid: { type: 'http' } } }, { mcpServers: { invalid: { command: 3 } } }, { mcpServers: { new: { type: 'http', url: '••••••••' } } }]) {
		await assert.rejects(save(a, view, invalid)); assert.equal(readFileSync(file, 'utf8'), beforeInvalid);
	}
	const first = structuredClone(view.config.document), second = structuredClone(view.config.document);
	first.mcpServers.fixture.timeout = 10000; second.mcpServers.fixture.timeout = 12000;
	const concurrent = await Promise.allSettled([save(a, view, first), save(b, view, second)]);
	assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
	await command(b, 'reload'); await wait(async () => (await command(b, 'status')).servers.some(server => server.tools.length));
	const project = await get(a, 'project');
	await save(a, project, { mcpServers: { fixture: { type: 'http', url: `http://127.0.0.1:${port}/project`, headers: { Authorization: 'Bearer PROJECT_SECRET' } } } });
	await command(a, 'reload'); await wait(() => requests.some(request => request.path === '/project' && request.key === 'Bearer PROJECT_SECRET' && request.method === 'tools/list'));
	assert((await command(a, 'status')).servers[0].source.endsWith('/.omp/mcp.json') || (await command(a, 'status')).servers[0].source.endsWith('\\.omp\\mcp.json'));
	await command(a, 'reconnect', { name: 'fixture' });
	await assert.rejects(command(a, 'reconnect', { name: 'not-owned' }));
	view = await get(a, 'project'); const disabled = structuredClone(view.config.document); disabled.mcpServers.fixture.enabled = false;
	await save(a, view, disabled); await command(a, 'reload');
	assert.equal((await command(a, 'status')).servers.length, 0, 'disabled project entry still shadows global server');
	assert.equal((await command(b, 'status')).servers.length, 1, 'other conversation remains connected');
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, mcp: { enableProjectConfig: false } }));
	await command(a, 'reload');
	await wait(async () => (await command(a, 'status')).servers.some(server => server.tools.length));
	assert.equal((await command(a, 'status')).projectConfigEnabled, false, 'explicit reload reads native project-discovery policy');
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false } }));
	await command(a, 'reload'); assert.equal((await command(a, 'status')).servers.length, 0);

	await a.stop(); assert.equal((await command(b, 'status')).servers.length, 1);
	assert.equal(await a.requestIfOpen('harness_mcp', { action: 'status' }), undefined);
	assert.equal(a.generation, undefined, 'status polling must not revive a stopped worker');
	await a.open(); assert.equal((await command(a, 'status')).servers.length, 0);
	// Stdio uses the shipped Bun binary, never a system node/bun on PATH.
	const bun = join(dirname(createRequire(join(ompTestRoot, 'package.json')).resolve('bun/package.json')), 'bin', 'bun.exe');
	const stdioScript = join(root, 'stdio-fixture.mjs'), pidFile = join(root, 'stdio.pid');
	writeFileSync(stdioScript, `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
const lines = createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));
lines.on('line', line => { const rpc = JSON.parse(line); if (rpc.id === undefined) return;
const result = rpc.method === 'initialize' ? { protocolVersion: rpc.params.protocolVersion, serverInfo: { name: 'stdio-fixture', version: '1' }, capabilities: { tools: {} } } : rpc.method === 'tools/list' ? { tools: process.env.MCP_FIXTURE_TOKEN === 'STDIO_SECRET' ? [{ name: 'stdio_echo', description: 'Local fixture', inputSchema: { type: 'object', properties: {} } }] : [] } : {};
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) + '\\n'); });`);
	view = await get(a);
	await save(a, view, { mcpServers: { stdio: { command: bun, args: [stdioScript, pidFile], env: { MCP_FIXTURE_TOKEN: 'STDIO_SECRET' }, envPolicy: 'literal' } } });
	await command(a, 'reload');
	await wait(async () => (await command(a, 'status')).servers.some(server => server.tools.includes('stdio_echo')));
	const childPid = Number(readFileSync(pidFile, 'utf8')); assert(Number.isSafeInteger(childPid));
	await a.stop(); await wait(() => { try { process.kill(childPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
	assert.equal((await command(b, 'status')).servers.length, 1, 'stopping stdio owner leaves another HTTP connection intact');
	const restricted = await open('restricted', { systemPrompt: 'Restricted fixture', toolNames: [] });
	await assert.rejects(get(restricted), /restricted/);
	if (process.platform !== 'win32') {
		renameSync(file, `${file}.original`); symlinkSync(`${file}.original`, file);
		try { await assert.rejects(get(b)); } finally { rmSync(file); renameSync(`${file}.original`, file); }
	}
	console.log('PASS native OMP MCP: masked config, atomic conflict/validation, unknown fields, independent reload/reconnect, project shadowing, tools/instructions, Stop/reopen and restricted sessions');
} finally { await Promise.allSettled(sessions.map(session => session.close())); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); rmSync(root, { recursive: true, force: true }); }
