/** Intentionally failing diagnostic outside passing smoke: tool-level MCP OAuth.
	* application: real host must show authorization (currently fails).
	* handler/refreshed: public handler must receive challenge (currently fail).
	* reconnected: control verifies challenge forwarding after explicit reconnect.
	* Controls return undefined, so a passing control does not prove OAuth works.
	*/
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const candidate = fileURLToPath(new URL('../../', import.meta.url));
const { OmpSession } = await import(pathToFileURL(join(candidate, 'dist/server/omp/session.js')));
const { listenIsolated } = await import(pathToFileURL(join(candidate, 'tests/lib/isolated-server.mjs')));
const { testEnv } = await import(pathToFileURL(join(candidate, 'tests/lib/test-env.mjs')));
const root = mkdtempSync(join(tmpdir(), 'omp-tool-auth-probe-'));
const cwd = join(root, 'workspace'), agent = join(root, 'omp/agent');
mkdirSync(cwd); mkdirSync(agent, { recursive: true });
let base, session, modelCalls = 0, challengedCalls = 0, issuerDiscovery = 0, fixtureError;
const methods = [];
const mode = process.argv[2] ?? 'application';
assert(['application', 'handler', 'reconnected', 'refreshed'].includes(mode), 'Unknown diagnostic mode');
const observed = join(root, 'handler.json');
const installed = join(root, 'installed');
const preload = join(root, 'local-network-only.mjs');
writeFileSync(preload, `const native = globalThis.fetch; const guarded = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('FIXTURE_BLOCKED_EXTERNAL_NETWORK'); return native(input, init); }; Object.assign(guarded, native); globalThis.fetch = guarded;`);
const env = testEnv({ BUN_OPTIONS: `--preload=${preload}` });
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^NODE_OPTIONS$|^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)) delete env[key];
const mcp = createServer(async (req, res) => {
	const url = new URL(req.url, base);
	const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
	if (url.pathname.includes('.well-known/oauth-protected-resource')) { issuerDiscovery++; return json({ resource: `${base}/mcp`, authorization_servers: [base] }); }
	if (url.pathname.includes('.well-known/')) { issuerDiscovery++; return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], client_id: 'fixture-client' }); }
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	let raw = ''; for await (const chunk of req) raw += chunk;
	const msg = JSON.parse(raw); methods.push(msg.method);
	if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
	let result = {};
	if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'scope-fixture', version: '1' } };
	if (msg.method === 'tools/list') result = { tools: [{ name: 'scoped_tool', description: 'Requires additional authorization at execution', inputSchema: { type: 'object', properties: {} } }] };
	if (msg.method === 'tools/call') { challengedCalls++; result = { isError: true, content: [{ type: 'text', text: 'Authorization required for scoped tool' }], _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", error="insufficient_scope", scope="fixture:read"`] } }; }
	json({ jsonrpc: '2.0', id: msg.id, result });
});
const model = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	const payload = JSON.parse(raw); modelCalls++;
	const policy = typeof payload.system === 'string' ? payload.system : (payload.system ?? []).map(p => p.text ?? '').join('\n');
	const route = /"scoped_tool" → `([^`]+)`/.exec(policy)?.[1];
	const toolName = payload.tools?.find(t => t.name === '_write' || t.name === 'write')?.name;
	if (modelCalls === 1 && (!route || !toolName)) fixtureError = 'Native MCP route absent';
	const call = modelCalls === 1 && route && toolName;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
	emit('message_start', { message: { id: `m-${modelCalls}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
	emit('content_block_start', { index: 0, content_block: call ? { type: 'tool_use', id: 'scope-call', name: toolName, input: {} } : { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify({ path: route, content: '{}' }) } : { type: 'text_delta', text: 'Tool authorization was not completed.' } });
	emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }); emit('message_stop', {}); res.end();
});
try {
	base = `http://127.0.0.1:${await listenIsolated(mcp)}`;
	const port = await listenIsolated(model);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'MODEL_FIXTURE', models: [{ id: 'fixture' }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { protected: { type: 'http', url: `${base}/mcp`, oauth: { clientId: 'fixture-client', callbackPort: 0 } } } }));
	if (mode !== 'application') {
		mkdirSync(join(agent, 'extensions'));
		const module = pathToFileURL(join(candidate, 'node_modules/@oh-my-pi/pi-coding-agent/src/mcp/manager.ts')).href;
		writeFileSync(join(agent, 'extensions/auth-probe.js'), `import { MCPManager } from ${JSON.stringify(module)}; import { writeFileSync } from 'node:fs'; export default api => api.on('session_start', async () => { const manager = MCPManager.instance(); if (!manager) throw Error('Missing native manager'); writeFileSync(${JSON.stringify(installed)}, 'installed'); manager.setAuthHandler(async (name, challenge) => { writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ name, challengeReceived: challenge.wwwAuthenticate.some(value => value.includes('fixture:read')) })); return undefined; }); ${mode === 'refreshed' ? `await manager.reconnectServer('protected', { manual: true }); await manager.refreshServerTools('protected');` : ''} });`);
	}
	session = new OmpSession({ conversationId: 'scope-challenge', dataDir: root, cwd, model: 'fixture/fixture', env, onChange() {} });
	await session.open();
	if (mode !== 'application') assert(existsSync(installed), 'control extension installed native auth handler');
	const status = async () => (await session.command('harness_mcp', { action: 'status' })).data;
	assert((await status()).servers.some(s => s.tools.includes('scoped_tool')), 'native discovery succeeded without login');
	if (mode === 'reconnected') await session.command('harness_mcp', { action: 'reconnect', name: 'protected' });
	await session.prompt('Call scoped_tool exactly once.');
	let auth;
	for (let i = 0; i < 200; i++) {
		assert(!fixtureError, fixtureError);
		auth = (await status()).auth;
		if (auth?.url || challengedCalls && !session.isStreaming) break;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	const handler = existsSync(observed) ? JSON.parse(readFileSync(observed, 'utf8')) : undefined;
	console.log(JSON.stringify({ mode, handler: handler ?? null, modelCalls, challengedCalls, issuerDiscovery, authStatus: auth?.status ?? 'absent', authorizationPresented: !!auth?.url, isStreaming: session.isStreaming, methods }));
	assert(challengedCalls >= 1, 'actual native tool reached the challenge');
	if (mode !== 'application') { assert(handler?.challengeReceived, 'Native manager auth handler must receive tool challenge'); console.log('PASS public auth handler received challenge'); } else {
	assert(auth?.url, 'Tool-level MCP challenge must present authorization before resuming model');
	assert.equal(modelCalls, 1, 'authorization waits without replaying or continuing the prompt');
	console.log('PASS native tool challenge requests authorization');
	}
} finally {
	await session?.close();
	for (const server of [mcp, model]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
	rmSync(root, { recursive: true, force: true });
}
