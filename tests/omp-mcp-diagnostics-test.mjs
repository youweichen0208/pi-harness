/** Real native connection failures, recovery, startup and conversation isolation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { listenIsolated } from './lib/isolated-server.mjs';
import { loadOmpTestModule, ompTestRoot } from './lib/omp-runtime-location.mjs';
import { testEnv } from './lib/test-env.mjs';
const { OmpSession } = await loadOmpTestModule('session.js');
const root = mkdtempSync(join(tmpdir(), 'omp-mcp-diagnostics-')), agent = join(root, 'omp/agent'), cwd = join(root, 'workspace');
mkdirSync(agent, { recursive: true }); mkdirSync(cwd);
const sessions = [], held = [];
let broken = true, calls = 0;
const secret = 'ARBITRARY_ECHOED_CREDENTIAL_927';
const fixture = createServer(async (req, res) => {
	calls++;
	if (req.url.startsWith('/slow')) { held.push(res); return; }
	if (broken) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end(secret); return; }
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	let raw = ''; for await (const chunk of req) raw += chunk;
	const message = JSON.parse(raw);
	if (message.id === undefined) { res.writeHead(202); res.end(); return; }
	const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } } : { tools: [] };
	res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
const status = async session => (await session.requestIfOpen('harness_mcp', { action: 'status' }))?.data;
const wait = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('MCP diagnostic fixture timed out'); };
const open = async id => { const session = new OmpSession({ conversationId: id, dataDir: root, cwd, model: 'fixture/fixture', env: testEnv(), onChange() {} }); sessions.push(session); await session.open(); return session; };
try {
	const bun = join(dirname(createRequire(join(ompTestRoot, 'package.json')).resolve('bun/package.json')), 'bin', 'bun.exe');
	const bounded = spawnSync(bun, [fileURLToPath(new URL('./fixtures/omp-mcp-diagnostics.mjs', import.meta.url)), ompTestRoot], { env: testEnv(), encoding: 'utf8', timeout: 15000 });
	assert.equal(bounded.status, 0, bounded.stderr || bounded.stdout); process.stdout.write(bounded.stdout);
	const port = await listenIsolated(fixture);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', apiKey: 'MODEL_SECRET', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'fixture' }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, mcp: { startupTimeoutMs: 20 } }));
	const config = { mcpServers: { broken: { type: 'http', url: `http://127.0.0.1:${port}/broken?custom=${secret}`, headers: { Authorization: `Bearer ${secret}` }, timeout: 500 } } };
	writeFileSync(join(agent, 'mcp.json'), JSON.stringify(config));
	const a = await open('diagnostics-a');
	let view = await status(a);
	assert(view.diagnostics, 'connection diagnostics must be available');
	await wait(async () => (await status(a)).diagnostics.events.some(event => event.type === 'failed'));
	view = await status(a);
	assert(!JSON.stringify(view).includes(secret), 'arbitrary echoed credentials cannot reach browser diagnostics');
	const failure = view.diagnostics.events.findLast(event => event.type === 'failed');
	assert.equal(failure.name, 'broken'); assert.equal(failure.transport, 'http');
	assert.equal(failure.failure, 'http_status'); assert.equal(failure.httpStatus, 403);
	assert.equal(view.servers.find(server => server.name === 'broken').failure.failure, 'http_status');
	const beforeRead = calls, sequence = view.diagnostics.events.at(-1).sequence;
	for (let i = 0; i < 5; i++) await status(a);
	assert.equal(calls, beforeRead, 'read-only diagnostics cannot probe connections');
	assert.equal((await status(a)).diagnostics.events.at(-1).sequence, sequence, 'polling does not duplicate events');
	const b = await open('diagnostics-b');
	await wait(async () => (await status(b)).diagnostics.events.some(event => event.type === 'failed'));
	const other = (await status(b)).diagnostics;
	broken = false;
	await a.command('harness_mcp', { action: 'reconnect', name: 'broken' });
	view = await status(a);
	assert.equal(view.servers[0].status, 'connected'); assert.equal(view.servers[0].failure, undefined);
	assert(view.diagnostics.events.some(event => event.type === 'failed'), 'recovery retains earlier failure evidence');
	assert.equal(view.diagnostics.events.at(-1).type, 'connected');
	assert.deepEqual((await status(b)).diagnostics, other, 'background conversations retain their own events');
	config.mcpServers = { slow: { type: 'http', url: `http://127.0.0.1:${port}/slow`, timeout: 30000 } };
	writeFileSync(join(agent, 'mcp.json'), JSON.stringify(config));
	const c = await open('diagnostics-slow');
	await wait(() => held.length > 0);
	const started = Date.now(), pending = await status(c);
	assert(Date.now() - started < 2000, 'diagnostics must not wait for startup completion');
	assert(pending.diagnostics.events.some(event => event.name === 'slow' && event.type === 'connecting'));
	await a.stop(); assert.equal(await status(a), undefined); assert.equal(a.generation, undefined, 'reading diagnostics cannot revive stopped worker');
	await a.open(); assert(!(await status(a)).diagnostics.events.some(event => event.name === 'broken'), 'worker restart starts a new diagnostic window');
	console.log('PASS native MCP diagnostics: initial failure, safe projection, read-only polling, recovery, isolation, pending startup and Stop/reopen');
} finally {
	for (const res of held) res.destroy();
	await Promise.allSettled(sessions.map(session => session.close()));
	fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); rmSync(root, { recursive: true, force: true });
}
