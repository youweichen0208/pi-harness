/** Local CONNECT/TLS fixtures; child runs the real native Bun transports. */
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const sockets = new Set(), appTunnels = [], fallbackTunnels = [], httpFallbackTunnels = [], hits = [], wsModes = [];
const upstreamAuth = [], targetAuth = [];
const expectedProxyAuth = `Basic ${Buffer.from('fixture:proxy:secret').toString('base64')}`;
let tlsPort, directPort, child;
const cert = resolve('tests/fixtures/openai-proxy/relay-cert.pem'), key = resolve('tests/fixtures/openai-proxy/key.pem');
const direct = createServer((req, res) => { hits.push(req.url); targetAuth.push({ path: req.url, authorization: req.headers.authorization }); assert(!req.headers['proxy-authorization']); res.end('DIRECT_FIXTURE'); });
const tls = createTlsServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (req, res) => {
	hits.push(req.url); assert(!req.headers['proxy-authorization']);
	let body = ''; for await (const part of req) body += part;
	if (req.url.includes('token')) {
		assert(body.includes('fixture-refresh'));
		const jwt = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`;
		res.setHeader('content-type','application/json'); res.end(JSON.stringify({ access_token: jwt, refresh_token: 'fixture-new-refresh', expires_in: 3600 }));
	} else if (req.url === '/redirect') { res.writeHead(302, { location: `http://127.0.0.1:${directPort}/redirected` }); res.end(); }
	else res.end('TLS_FIXTURE');
});
const directWs = new WebSocketServer({ server: direct });
let directWsCount = 0;
directWs.on('connection', socket => { directWsCount++; socket.send('DIRECT_WS'); });
const wss = new WebSocketServer({ server: tls });
wss.on('connection', (socket, req) => { wsModes.push(req.headers['x-fixture']); socket.on('message', () => socket.send(JSON.stringify({ type:'response.completed', response:{ id:crypto.randomUUID(), status:'completed', output:[] } }))); });
function proxy(tunnels, allowed, secure = false, upstreamPort = () => tlsPort) {
	const server = secure ? createTlsServer({ cert: readFileSync(cert), key: readFileSync(key) }) : createServer();
	server.on('connect', (req, socket, head) => {
		tunnels.push(req.url);
		if (tunnels === fallbackTunnels || tunnels === httpFallbackTunnels) upstreamAuth.push({ proxy: req.headers['proxy-authorization'], origin: req.headers.authorization });
		if (!allowed.includes(req.url)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
		const upstream = connect(upstreamPort(), '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if(head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
		for(const stream of [socket, upstream]) { sockets.add(stream); stream.on('close',()=>sockets.delete(stream)); stream.on('error',()=>{socket.destroy();upstream.destroy();}); }
	}); return server;
}
const app = proxy(appTunnels,['api.openai.com:443','auth.openai.com:443','chatgpt.com:443']), fallback = proxy(fallbackTunnels,['custom.fixture:443','api.openai.com:9001']), denied = proxy([],[]), secure = proxy(appTunnels,['api.openai.com:443'],true), httpFallback = proxy(httpFallbackTunnels,['custom.fixture:9001'],false,() => directPort);
httpFallback.on('request', (incoming, outgoing) => {
	const target = new URL(incoming.url);
	if (target.hostname !== 'custom.fixture') { outgoing.writeHead(403); outgoing.end(); return; }
	upstreamAuth.push({ proxy: incoming.headers['proxy-authorization'], origin: incoming.headers.authorization, path: target.pathname });
	const headers = { ...incoming.headers, host: `127.0.0.1:${directPort}` };
	delete headers['proxy-authorization']; delete headers['proxy-connection'];
	const request = httpRequest({ hostname: '127.0.0.1', port: directPort, path: target.pathname, method: incoming.method, headers, agent: false }, response => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); });
	request.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
	outgoing.on('close', () => request.destroy()); incoming.pipe(request);
});
try {
	tlsPort=await listenIsolated(tls); directPort=await listenIsolated(direct);
	const securePort=await listenIsolated(secure), httpFallbackPort=await listenIsolated(httpFallback);
	const appPort=await listenIsolated(app), fallbackPort=await listenIsolated(fallback), deniedPort=await listenIsolated(denied);
	const env=testEnv({NODE_EXTRA_CA_CERTS:cert,OMP_PROXY_FIXTURE:JSON.stringify({proxy:`http://127.0.0.1:${appPort}`,secure:`https://127.0.0.1:${securePort}`,fallback:`http://fixture:proxy%3Asecret@127.0.0.1:${fallbackPort}`,httpFallback:`http://fixture:proxy%3Asecret@127.0.0.1:${httpFallbackPort}`,denied:`http://127.0.0.1:${deniedPort}`,direct:`http://127.0.0.1:${directPort}`,directTls:`https://127.0.0.1:${tlsPort}`})});
	for(const name of Object.keys(env)) if(/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^BUN_OPTIONS$|^NODE_OPTIONS$|^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name)) delete env[name];
	const require=createRequire(import.meta.url);
	child=spawn(join(dirname(require.resolve('bun/package.json')),'bin/bun.exe'),['tests/fixtures/omp-proxy-transports.mjs'],{env,stdio:['ignore','inherit','inherit']});
	const timer=setTimeout(()=>child.kill(),30000);
	try { const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}); assert.equal(code,0); } finally {clearTimeout(timer);}
	assert(appTunnels.includes('api.openai.com:443')); assert(appTunnels.includes('auth.openai.com:443')); assert(appTunnels.includes('chatgpt.com:443'));
	assert.equal(directWsCount, 1); assert.deepEqual(fallbackTunnels,['custom.fixture:443','api.openai.com:9001']); assert.deepEqual(httpFallbackTunnels,['custom.fixture:9001']); assert.deepEqual(wsModes,['native-ws','native-ws']);
	assert(hits.includes('/redirected')); assert(!hits.includes('/unauthorized')); assert(!hits.includes('/failure'));
	assert.equal(upstreamAuth.length, 5);
	for (const entry of upstreamAuth) {
		assert.equal(entry.proxy, expectedProxyAuth, 'only the upstream receives proxy authentication');
		assert.equal(entry.origin, entry.path === '/authenticated' ? 'Bearer origin-fixture' : undefined, 'proxy credentials cannot become origin Authorization');
	}
	assert.deepEqual(targetAuth.filter(entry => ['/anonymous', '/authenticated'].includes(entry.path)), [
		{ path: '/anonymous', authorization: undefined }, { path: '/authenticated', authorization: 'Bearer origin-fixture' },
	]);
	console.log('PASS application proxy preserves native transport paths and endpoint scope');
} finally { child?.kill(); for(const socket of sockets)socket.destroy();for(const socket of wss.clients)socket.terminate();wss.close();for(const socket of directWs.clients)socket.terminate();directWs.close();for(const server of [app,fallback,httpFallback,denied,secure,tls,direct]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));} }
