/** Actual OMP worker transport probe. Fails while the host proxy setting is ignored.
 * --native-control configures PI_PROXY only inside this isolated diagnostic worker
 * to distinguish native transport support from missing application integration.
 * Outbound fetches are blocked unless they target loopback or the fixture proxy.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { OpenAIProxySettings } from '../dist/server/openai-proxy.js';
import { createOmpRuntime, stopOmpRuntime } from '../dist/server/omp/runtime.js';
import { listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';

const root = mkdtempSync(join(tmpdir(), 'omp-proxy-probe-')), dataDir = join(root, 'data'), cwd = join(root, 'project');
const agent = join(dataDir, 'omp/agent'), blocked = join(root, 'blocked.jsonl'), preload = join(root, 'guard.mjs');
for (const path of [agent, cwd]) mkdirSync(path, { recursive: true });
const cert = resolve('tests/fixtures/openai-proxy/cert.pem'), key = resolve('tests/fixtures/openai-proxy/key.pem');
const events = [], tunnels = [], requests = [], sockets = new Set();
let runtime, peer, tlsPort, proxyPort, held, heldClosed = false;
const provider = createTlsServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	requests.push({ url: req.url, body: JSON.parse(raw) });
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	if (raw.includes('HOLD_STREAM_FOR_STOP')) { held = res; res.on('close', () => { heldClosed = true; }); res.flushHeaders(); return; }
	res.end('data: ' + JSON.stringify({ id: 'proxy-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'OMP_PROXY_VERIFIED' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\ndata: [DONE]\n\n');
});
const proxy = createServer();
proxy.on('connect', (req, socket, head) => {
	tunnels.push(req.url);
	if (req.url !== 'api.openai.com:443') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
	const upstream = connect(tlsPort, '127.0.0.1', () => {
		socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		if (head.length) upstream.write(head);
		socket.pipe(upstream); upstream.pipe(socket);
	});
	for (const stream of [socket, upstream]) {
		sockets.add(stream); stream.on('close', () => sockets.delete(stream));
		stream.on('error', () => { socket.destroy(); upstream.destroy(); });
	}
});
try {
	tlsPort = await listenIsolated(provider); proxyPort = await listenIsolated(proxy);
	const proxyUrl = `http://127.0.0.1:${proxyPort}`;
	writeFileSync(join(dataDir, 'openai-proxy.json'), JSON.stringify({ enabled: !process.argv.includes('--native-control'), url: proxyUrl }));
	new OpenAIProxySettings(dataDir).install();
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false } }));
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-only', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
	writeFileSync(preload, `import { appendFileSync } from 'node:fs';
const nativeFetch = globalThis.fetch;
const guarded = (input, init) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
 let relay; try { relay = new URL(typeof init?.proxy === 'string' ? init.proxy : process.env.HTTPS_PROXY || ''); } catch {}
 const scopedProxy = url.hostname === 'api.openai.com' && (init?.proxy === ${JSON.stringify(proxyUrl)} || relay?.hostname === '127.0.0.1' && relay.username === 'omp');
 if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !scopedProxy) {
  appendFileSync(${JSON.stringify(blocked)}, JSON.stringify({ host: url.hostname, path: url.pathname }) + '\\n');
  throw Error('FIXTURE_BLOCKED_DIRECT_NETWORK');
 }
 return nativeFetch(input, init);
};
Object.assign(guarded, nativeFetch); globalThis.fetch = guarded;
${process.argv.includes('--native-control') ? `process.env.PI_PROXY = ${JSON.stringify(proxyUrl)};` : ''}
`);
	const env = testEnv({ NODE_EXTRA_CA_CERTS: cert, BUN_OPTIONS: `--preload=${preload}` });
	for (const name of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^NODE_OPTIONS$|^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name)) delete env[name];
	runtime = await createOmpRuntime({ conversationId: 'proxy-probe', dataDir, cwd, env, model: 'fixture/fixture', thinking: 'off', restricted: { systemPrompt: 'Reply briefly.', toolNames: [] }, onEvent: event => events.push(event), onExit: () => {} });
	await runtime.request('prompt', { message: 'Verify the configured application proxy.' });
	for (let i = 0; i < 600 && !events.some(event => event.frame.type === 'session_settled'); i++) await sleep(25);
	assert(events.some(event => event.frame.type === 'session_settled'), 'native task must settle within fixture deadline');
	const messages = (await runtime.request('get_messages')).data.messages;
	const last = messages.findLast(message => message.role === 'assistant');
	const blockedRequests = existsSync(blocked) ? readFileSync(blocked, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
	const result = { blockedHosts: [...new Set(blockedRequests.map(request => request.host))], control: process.argv.includes('--native-control'), proxyConnects: tunnels.length, providerRequests: requests.length, blockedDirectRequests: blockedRequests.filter(request => ['api.openai.com', 'auth.openai.com', 'chatgpt.com'].includes(request.host)).length, stopReason: last?.stopReason, responseReceived: JSON.stringify(last?.content).includes('OMP_PROXY_VERIFIED') };
	console.log(JSON.stringify(result));
	assert.equal(result.providerRequests, 1, 'application proxy must carry the actual OMP model request');
	assert.equal(result.blockedDirectRequests, 0, 'configured official endpoint must never attempt direct traffic');
	assert.equal(result.responseReceived, true);
	if (!process.argv.includes('--native-control')) {
		// Saving a different proxy must not affect new/reloaded workers until
		// the host restarts. Test every business session's common launch path.
		const settings = new OpenAIProxySettings(dataDir);
		settings.save({ enabled: true, url: 'http://127.0.0.1:9' }, settings.state().version);
		for (const kind of ['wiki', 'ssh', 'playground', 'auth']) {
			await stopOmpRuntime(runtime); runtime = undefined; events.length = 0;
			const before = requests.length;
			runtime = await createOmpRuntime({ conversationId: kind, kind, dataDir, cwd, env, model: 'fixture/fixture', thinking: 'off', restricted: { systemPrompt: 'Reply briefly.', toolNames: [] }, onEvent: event => events.push(event), onExit: () => {} });
			await runtime.request('prompt', { message: 'Same startup proxy for ' + kind });
			for (let i = 0; i < 600 && !events.some(event => event.frame.type === 'session_settled'); i++) await sleep(25);
			assert(events.some(event => event.frame.type === 'session_settled'));
			assert.equal(requests.length, before + 1, kind + ' retains startup proxy after save');
		}
		peer = await createOmpRuntime({ conversationId: 'peer', dataDir, cwd, env, model: 'fixture/fixture', thinking: 'off', restricted: { systemPrompt: 'Reply briefly.', toolNames: [] }, onEvent: event => events.push(event), onExit: () => {} });
		await runtime.request('prompt', { message: 'HOLD_STREAM_FOR_STOP' });
		for (let i = 0; i < 200 && !held; i++) await sleep(25);
		assert(held, 'model stream remains open before Stop');
		assert.equal(heldClosed, false);
		await stopOmpRuntime(runtime); runtime = undefined; events.length = 0;
		for (let i = 0; i < 200 && !heldClosed; i++) await sleep(25);
		assert(heldClosed, 'Stop closes the outstanding TLS model stream');
		const beforePeer = requests.length;
		await peer.request('prompt', { message: 'Continue after another worker stops.' });
		for (let i = 0; i < 600 && !events.some(event => event.conversationId === 'peer' && event.frame.type === 'session_settled'); i++) await sleep(25);
		assert.equal(requests.length, beforePeer + 1, 'stopping one relay does not close another');
		assert(JSON.stringify((await peer.request('get_messages')).data.messages).includes('OMP_PROXY_VERIFIED'));
		assert(!JSON.stringify(events).includes(proxyUrl), 'proxy configuration is not exposed in model or UI events');
		console.log('PASS active TLS stream Stop plus actual OMP application proxy and startup snapshot across chat/Wiki/SSH/Playground/auth workers');
	}

} finally {
	if (runtime) await stopOmpRuntime(runtime);
	if (peer) await stopOmpRuntime(peer);
	for (const socket of sockets) socket.destroy();
	for (const server of [proxy, provider]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
	rmSync(root, { recursive: true, force: true });
}
