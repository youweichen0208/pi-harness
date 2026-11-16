/** Real OMP OAuth, local issuer/resource only; no account or model requests. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOmpTestModule } from './lib/omp-runtime-location.mjs';
import { listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const { OmpSession } = await loadOmpTestModule('session.js');
const root = mkdtempSync(join(tmpdir(), 'omp-mcp-auth-')), cwd = join(root, 'workspace'), agent = join(root, 'omp/agent');
mkdirSync(agent, { recursive: true }); mkdirSync(cwd);
const sessions = [], requests = [], challenges = new Map();
let base, tokenCount = 0, invalidAuthorization = false;
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
	if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
	return json(200, { jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion, serverInfo: { name: 'oauth-fixture', version: '1' }, capabilities: { tools: {} } } : msg.method === 'tools/list' ? { tools: [{ name: 'authenticated_tool', description: 'OAuth fixture', inputSchema: { type: 'object', properties: {} } }] } : {} });
});
const command = async (session, action, extra = {}) => (await session.command('harness_mcp', { action, ...extra })).data;
const wait = async (fn, label) => { for (let i = 0; i < 400; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(`Timed out: ${label}`); };
const status = session => command(session, 'status');
const pending = session => wait(async () => { const view = await status(session); assert.notEqual(view.auth?.status, 'failed'); return view.auth?.url ? view.auth : undefined; }, 'OAuth URL');
const complete = session => wait(async () => { const view = await status(session); assert.notEqual(view.auth?.status, 'failed'); return view.auth?.status === 'complete' && view; }, 'OAuth completion');
const callback = auth => { const url = new URL(auth.url); assert.equal(url.origin, base); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); const code = `code-${challenges.size}`; challenges.set(code, url.searchParams.get('code_challenge')); const redirect = new URL(url.searchParams.get('redirect_uri')); assert(Number(redirect.port) >= 8900); redirect.searchParams.set('code', code); redirect.searchParams.set('state', url.searchParams.get('state')); return redirect; };
const open = async id => { const session = new OmpSession({ conversationId: id, dataDir: root, cwd, model: 'fixture/fixture', env: testEnv(), onChange() {} }); sessions.push(session); await session.open(); return session; };
try {
	base = `http://127.0.0.1:${await listenIsolated(fixture)}`;
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', apiKey: 'MODEL_SECRET', models: [{ id: 'fixture' }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false } }));
	const configPath = join(agent, 'mcp.json');
	writeFileSync(configPath, JSON.stringify({ mcpServers: { protected: { type: 'http', url: `${base}/mcp`, oauth: { clientId: 'fixture-client', callbackPort: 0 } } } }));
	const original = readFileSync(configPath, 'utf8'), a = await open('a'), b = await open('b');
	await command(a, 'login', { name: 'protected' });
	let auth = await pending(a);
	assert.equal((await status(b)).auth, undefined, 'another conversation cannot see authorization URL/input');
	await assert.rejects(command(b, 'auth_cancel', { authId: auth.id }));
	await assert.rejects(command(a, 'auth_input', { authId: 'stale', value: 'SECRET_CODE' }));
	await assert.rejects(command(a, 'login', { name: 'protected' }));
	await assert.rejects(command(a, 'reload'));
	await assert.rejects(a.prompt('must not invoke model during OAuth'));
	await command(a, 'auth_cancel', { authId: auth.id });
	assert.equal((await status(a)).auth.status, 'cancelled'); assert.equal(tokenCount, 0);
	assert.equal(readFileSync(configPath, 'utf8'), original);
	await command(a, 'login', { name: 'protected' }); auth = await pending(a);
	const redirect = callback(auth);
	const wrong = new URL(redirect); wrong.searchParams.set('state', 'wrong'); await fetch(wrong);
	assert.equal(tokenCount, 0, 'wrong state never reaches token exchange');
	await fetch(redirect);
	let view = await complete(a);
	assert.equal(view.servers[0].authenticated, true); assert(view.servers[0].tools.includes('authenticated_tool'));
	assert(requests.includes('tools/list')); assert.equal(tokenCount, 1);
	for (const secret of ['ACCESS_SECRET', 'REFRESH_SECRET', 'MODEL_SECRET', 'SECRET_CODE']) assert(!JSON.stringify(view).includes(secret));
	const c = await open('restored'); assert.equal((await status(c)).servers[0].authenticated, true); await c.stop();
	assert.equal(view.auth.url, undefined); assert.equal(readFileSync(configPath, 'utf8'), original, 'definition-only OAuth does not rewrite project/shareable configuration');
	assert.equal((await status(b)).servers[0].status, 'disconnected', 'other live conversation not silently reconnected');
	await command(a, 'login', { name: 'protected' }); auth = await pending(a);
	await wait(async () => (await status(a)).auth.inputRequired, 'manual input');
	await command(a, 'auth_input', { authId: auth.id, value: callback(auth).href }); await complete(a); assert.equal(tokenCount, 2);
	await command(a, 'logout', { name: 'protected' }); view = await status(a);
	assert.equal(view.auth.status, 'signed_out'); assert.equal(view.servers.length, 0, 'native disconnect removes the runtime entry');
	await command(a, 'reload'); view = await status(a);
	assert.equal(view.servers[0].authenticated, false); assert.equal(view.servers[0].status, 'disconnected');
	await command(a, 'login', { name: 'protected' }); auth = await pending(a); const stoppedCallback = callback(auth);
	await a.stop(); assert.equal(await a.requestIfOpen('harness_mcp', { action: 'status' }), undefined);
	await assert.rejects(fetch(stoppedCallback)); assert.equal(tokenCount, 2);
	await a.open(); assert.equal((await status(a)).auth, undefined); assert.equal((await status(a)).servers[0].authenticated, false);
	invalidAuthorization = true;
	await command(a, 'login', { name: 'protected' });
	const failed = await wait(async () => { const view = await status(a); return view.auth?.status === 'failed' && view; }, 'invalid authorization URL rejected');
	assert.equal(failed.auth.url, undefined); assert.equal(tokenCount, 2);
	console.log('PASS OMP MCP OAuth: native discovery/PKCE/state, browser and manual callbacks, persistence, masked projection, stale IDs, cancellation, independent sessions, logout and Stop/reopen');
} finally { await Promise.allSettled(sessions.map(session => session.close())); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); rmSync(root, { recursive: true, force: true }); }
