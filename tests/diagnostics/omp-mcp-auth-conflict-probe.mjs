/** Diagnostic outside passing smoke: OAuth must preserve edits made while the browser is open.
 * Modes: control/peer are controls; same-server and definition-only assert conflict safety.
 * Uses fake credentials and loopback services only. Failures remain failures.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listenIsolated } from '../lib/isolated-server.mjs';
import { testEnv } from '../lib/test-env.mjs';
assert(process.argv.length <= 4, 'Expected mode and optional application root');
const applicationRoot = realpathSync(process.argv[3] ? resolve(process.argv[3]) : fileURLToPath(new URL('../../', import.meta.url)));
const { OmpSession } = await import(pathToFileURL(join(applicationRoot, 'dist/server/omp/session.js')).href);
const root = mkdtempSync(join(tmpdir(), 'omp-mcp-auth-conflict-')), cwd = join(root, 'workspace'), agent = join(root, 'omp/agent');
mkdirSync(agent, { recursive: true }); mkdirSync(cwd);
const sessions = [], requests = [], challenges = new Map();
let base, tokenCount = 0, invalidAuthorization = false;
const mode = process.argv[2] ?? 'same-server';
assert(['control', 'peer', 'same-server', 'definition-only', 'url-change', 'disable', 'delete', 'shadow', 'global-deny', 'project-policy', 'definition-edit', 'discovered', 'discovered-edit'].includes(mode));
let editing = false, authenticatedAfterEdit = 0;
const fixture = createServer(async (req, res) => {
	const url = new URL(req.url, base), json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
	if (url.pathname.includes('.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
	if (url.pathname.includes('.well-known/')) return json(200, { issuer: base, authorization_endpoint: invalidAuthorization ? "javascript:alert(1)" : `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], client_id: 'fixture-client' });
	let raw = ''; for await (const chunk of req) raw += chunk;
	if (url.pathname === '/token') {
		const params = new URLSearchParams(raw), challenge = challenges.get(params.get('code'));
		assert(challenge, 'only a code authorized by this fixture may be exchanged');
		assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge);
		tokenCount++; return json(200, { access_token: 'ACCESS_SECRET', refresh_token: 'REFRESH_SECRET', token_type: 'Bearer', expires_in: 3600 });
	}
	if (url.pathname !== '/mcp') return json(404, {});
	if (req.headers.authorization !== 'Bearer ACCESS_SECRET') {
		res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
		return json(401, { error: 'unauthorized' });
	}
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	const msg = JSON.parse(raw); requests.push(msg.method);
	if (editing) authenticatedAfterEdit++;
	if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
	return json(200, { jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion, serverInfo: { name: 'oauth-fixture', version: '1' }, capabilities: { tools: {} } } : msg.method === 'tools/list' ? { tools: [{ name: 'authenticated_tool', description: 'OAuth fixture', inputSchema: { type: 'object', properties: {} } }] } : {} });
});
const command = async (session, action, extra = {}) => (await session.command('harness_mcp', { action, ...extra })).data;
const wait = async (fn, label) => { for (let i = 0; i < 400; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(`Timed out: ${label}`); };
const status = session => command(session, 'status');
const pending = session => wait(async () => { const view = await status(session); assert.notEqual(view.auth?.status, 'failed'); return view.auth?.url ? view.auth : undefined; }, 'OAuth URL');
const complete = session => wait(async () => { const view = await status(session); assert.notEqual(view.auth?.status, 'failed'); return view.auth?.status === 'complete' && view; }, 'OAuth completion');
const callback = auth => { const url = new URL(auth.url); assert.equal(url.origin, base); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); const code = `code-${challenges.size}`; challenges.set(code, url.searchParams.get('code_challenge')); const redirect = new URL(url.searchParams.get('redirect_uri')); assert(Number(redirect.port) >= 8900); redirect.searchParams.set('code', code); redirect.searchParams.set('state', url.searchParams.get('state')); return redirect; };
const preload = join(root, 'loopback-only.mjs');
writeFileSync(preload, `const native = globalThis.fetch; const guarded = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('FIXTURE_BLOCKED_EXTERNAL_NETWORK'); return native(input, init); }; Object.assign(guarded, native); globalThis.fetch = guarded;`);
const env = testEnv({ BUN_OPTIONS: `--preload=${preload}` });
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^NODE_OPTIONS$|^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)) delete env[key];
const open = async id => { const session = new OmpSession({ conversationId: id, dataDir: root, cwd, model: 'fixture/fixture', env, onChange() {} }); sessions.push(session); await session.open(); return session; };
try {
	base = `http://127.0.0.1:${await listenIsolated(fixture)}`;
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', apiKey: 'MODEL_FIXTURE', models: [{ id: 'fixture' }] } } }));
	const discoveredDir = join(root, 'extension'); mkdirSync(discoveredDir); writeFileSync(join(discoveredDir, 'index.js'), 'export default () => {};');
	writeFileSync(join(discoveredDir, 'package.json'), JSON.stringify({ name: 'auth-fixture', version: '1.0.0', type: 'module', omp: { extensions: ['./index.js'] } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false }, extensions: mode.startsWith('discovered') ? [discoveredDir] : [] }));
	const projectDir = join(cwd, '.omp'); mkdirSync(projectDir);
	const configPath = join(mode.startsWith('discovered') ? discoveredDir : mode === 'project-policy' ? projectDir : agent, 'mcp.json');
	const original = { future: { retained: true }, mcpServers: {
		protected: { type: 'http', url: `${base}/mcp`, timeout: 1000, ...(['control', 'peer', 'same-server'].includes(mode) ? { headers: { Authorization: 'Bearer STALE_FIXTURE' } } : {}), oauth: { clientId: 'fixture-client', callbackPort: 0 } },
		peer: { type: 'stdio', command: 'MUST_NOT_RUN_DISABLED_PEER', enabled: false }
	} };
	writeFileSync(configPath, JSON.stringify(original));
	const session = await open('conflict');
	assert((await status(session)).servers.some(server => server.name === 'protected'), 'fixture service must be discovered before testing OAuth');
	await command(session, 'login', { name: 'protected' });
	const auth = await pending(session);
	const external = structuredClone(original);
	if (mode === 'peer') external.mcpServers.peer.timeout = 42;
	if (mode === 'same-server') { external.mcpServers.protected.timeout = 9876; external.mcpServers.protected.future = { edited: true }; }
	if (mode === 'definition-only') { external.mcpServers.protected.url = `${base}/new-resource`; external.mcpServers.protected.enabled = false; }
	if (mode === 'url-change') external.mcpServers.protected.url = `${base}/new-resource`;
	if (mode === 'disable') external.mcpServers.protected.enabled = false;
	if (mode === 'delete') delete external.mcpServers.protected;
	if (mode === 'definition-edit' || mode === 'discovered-edit') external.mcpServers.protected.timeout = 9876;
	if (mode === 'global-deny') external.disabledServers = ['protected'];
	if (mode === 'shadow') writeFileSync(join(projectDir, 'mcp.json'), JSON.stringify({ mcpServers: { protected: { ...original.mcpServers.protected, timeout: 4321 } } }));
	if (mode === 'project-policy') writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, mcp: { enableProjectConfig: false } }));
	if (mode !== 'control') { editing = true; writeFileSync(configPath, JSON.stringify(external)); }
	await fetch(callback(auth));
	const final = await wait(async () => { const view = await status(session); return view.auth && view.auth.status !== 'pending' && view; }, 'terminal OAuth state');
	const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
	const sameEditPreserved = persisted.mcpServers.protected?.timeout === 9876 && persisted.mcpServers.protected?.future?.edited === true;
	const peerEditPreserved = persisted.mcpServers.peer.timeout === 42;
	const definitionPreserved = persisted.mcpServers.protected?.url === `${base}/new-resource` && persisted.mcpServers.protected?.enabled === false;
	console.log(JSON.stringify({ mode, tokenCount, authStatus: final.auth.status, sameEditPreserved, peerEditPreserved, definitionPreserved, authenticatedAfterEdit, connectionStatus: final.servers.find(server => server.name === 'protected')?.status, configAuthWritten: !!persisted.mcpServers.protected?.auth, unrelatedRootPreserved: persisted.future?.retained === true }));
	assert.equal(tokenCount, 1, 'real native OAuth grant completed once');
	assert.equal(persisted.future.retained, true);
	if (mode === 'control' || mode === 'peer' || mode === 'discovered') {
		assert.equal(final.auth.status, 'complete');
		if (mode === 'peer') assert(peerEditPreserved, 'editing another service must survive native OAuth persistence');
	} else if (mode === 'same-server') {
		assert(sameEditPreserved, 'OAuth completion must not overwrite external edits to the selected definition');
	} else {
		assert.deepEqual(persisted, external, 'definition-only grant must preserve the edited file');
		assert.equal(authenticatedAfterEdit, 0, 'do not reconnect the obsolete server after its definition changed during login');
		assert.equal(final.auth.status, 'configuration_changed', 'changed or disabled definition requires explicit reload, credentials may already exist');
	}
} finally { await Promise.allSettled(sessions.map(session => session.close())); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); rmSync(root, { recursive: true, force: true }); }
