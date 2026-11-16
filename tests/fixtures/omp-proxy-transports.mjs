/** Bun fixture: real native OAuth + both native WebSocket transports. */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { installOmpProxy, createOmpProxy } from '../../dist/server/omp/openai-proxy.js';
import { getProxyForUrl } from '@oh-my-pi/pi-ai/utils/proxy';
import { refreshOAuthToken } from '@oh-my-pi/pi-ai/registry/oauth/index';
import { ResponsesWebSocketConnection } from '@oh-my-pi/pi-ai/providers/responses-websocket-connection';
const config = JSON.parse(process.env.OMP_PROXY_FIXTURE);
delete process.env.OMP_PROXY_FIXTURE;
const closes = [];
try {
	process.env.HTTPS_PROXY = config.fallback; process.env.HTTP_PROXY = config.httpFallback;
	const close = await installOmpProxy({ enabled: true, url: config.proxy }); closes.push(close);
	const relayUrl = new URL(process.env.HTTPS_PROXY); assert.equal(relayUrl.hostname, '127.0.0.1');
	const rawFetch = globalThis.fetch;
	// No external network: only fixture origins or loopback are allowed; every
	// public origin must carry the authenticated relay URL explicitly.
	const guarded = (input, init) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
		assert(['api.openai.com','auth.openai.com','chatgpt.com','custom.fixture','localhost','127.0.0.1'].includes(url.hostname));
		return rawFetch(input, init);
	};
	Object.assign(guarded, rawFetch); globalThis.fetch = guarded;
	assert.equal(await (await fetch('https://api.openai.com/probe')).text(), 'TLS_FIXTURE');
	const token = await refreshOAuthToken('openai-codex', { access: 'fixture', refresh: 'fixture-refresh', expires: 0 });
	assert(token.access); assert.equal(token.refresh, 'fixture-new-refresh');
	for (const inspectUpgradeResponse of [false, true]) {
		const url = 'wss://chatgpt.com/backend-api/codex/responses';
		const proxy = getProxyForUrl('openai-codex', new URL(url)); assert.equal(proxy, process.env.HTTPS_PROXY);
		const connection = new ResponsesWebSocketConnection({ url, proxy, headers: { 'x-fixture': 'native-ws' }, inspectUpgradeResponse, connectTimeoutMs: 5000, maxIdleReuseMs: 1000, messageQueueCapacity: 100, heartbeat: { intervalMs: 100, pongTimeoutMs: 1000 } });
		try {
			await connection.connect();
			const frames = [];
			for await (const frame of connection.streamRequest({ send: { type: 'response.create' } }, { firstEventTimeoutMs: 5000, idleTimeoutMs: 5000 })) frames.push(frame);
			assert(frames.some(frame => frame.type === 'response.completed'));
		} finally { connection.close(); }
	}
	const customSocket = new WebSocket('ws://custom.fixture:9001/socket', { proxy: getProxyForUrl('custom', new URL('ws://custom.fixture:9001/socket')) });
	await new Promise((resolve, reject) => {
		customSocket.addEventListener('message', event => { assert.equal(event.data, 'DIRECT_WS'); customSocket.close(); resolve(); });
		customSocket.addEventListener('error', reject);
	});
	assert.equal(await (await fetch(config.direct + '/direct')).text(), 'DIRECT_FIXTURE');
	// Force a local TLS request through the relay to exercise its direct tunnel.
	assert.equal(await (await fetch(config.directTls + '/custom', { proxy: process.env.HTTPS_PROXY })).text(), 'TLS_FIXTURE');
	// A custom remote origin must keep the inherited proxy, never the app proxy.
	assert.equal(await (await fetch('https://custom.fixture/custom')).text(), 'TLS_FIXTURE');
	assert.equal(await (await fetch('http://custom.fixture/anonymous')).text(), 'DIRECT_FIXTURE');
	assert.equal(await (await fetch('http://custom.fixture/authenticated', { headers: { Authorization: 'Bearer origin-fixture' } })).text(), 'DIRECT_FIXTURE');
	assert.equal(await (await fetch('https://api.openai.com:9001/nonstandard')).text(), 'TLS_FIXTURE');
	// Redirects must re-evaluate destination scope inside the relay.
	assert.equal(await (await fetch('https://api.openai.com/redirect')).text(), 'DIRECT_FIXTURE');
	const unauthenticated = await new Promise((resolve, reject) => {
		const req = httpRequest({ hostname: relayUrl.hostname, port: relayUrl.port, path: config.direct + '/unauthorized' }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end();
	}); assert.equal(unauthenticated, 407);
	const secure = await createOmpProxy({ enabled: true, url: config.secure }); closes.push(secure.close);
	assert.equal(await (await rawFetch('https://api.openai.com/secure', { proxy: secure.url })).text(), 'TLS_FIXTURE');
	const dead = await createOmpProxy({ enabled: true, url: config.denied }); closes.push(dead.close);
	await assert.rejects(rawFetch('https://api.openai.com/failure', { proxy: dead.url, signal: AbortSignal.timeout(5000) }));
	await close();
	await assert.rejects(rawFetch('https://api.openai.com/closed', { proxy: relayUrl.href, signal: AbortSignal.timeout(5000) }));
	console.log('PASS native proxy transports: HTTP, OAuth refresh, both WebSockets, direct/custom fallback, redirects, authentication, failure and shutdown');
} finally { for (const close of closes) await close(); }
