/** Product model-management actions through real OMP workers, with a local catalogue. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOmpTestModule, ompTestRoot } from './lib/omp-runtime-location.mjs';
import { listenIsolated } from './lib/isolated-server.mjs';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete process.env[key];
const { OmpClientSession } = await loadOmpTestModule('chat-service.js');
const { ClientStateStore } = await import(pathToFileURL(join(ompTestRoot, 'dist/server/client-state.js')).href);
const root = mkdtempSync(join(tmpdir(), 'omp-catalog-')), agent = join(root, 'omp/agent');
mkdirSync(agent, { recursive: true });
const events = [], requests = [];
let client, reqId = 0, rejectSaved = false, releaseHeld;
const server = createServer(async (req, res) => {
	requests.push({ url: req.url, headers: req.headers });
	if (req.url === '/hold/models') await new Promise(resolve => { releaseHeld = resolve; });
	if (req.url === '/denied/models' || rejectSaved && req.url === '/catalog/models') { res.writeHead(401); res.end('SECRET_FROM_ERROR_BODY'); return; }
	if (req.url === '/redirect/models') { res.writeHead(302, { location: '/credential-sink' }); res.end(); return; }
	if (req.url === '/fallback/models') { res.writeHead(404); res.end(); return; }
	res.writeHead(200, { 'content-type': 'application/json' });
	if (req.url === '/huge/models') { res.end(JSON.stringify({ data: [], padding: 'x'.repeat(4 * 1024 * 1024) })); return; }
	if (req.url === '/invalid/models') { res.end(JSON.stringify({ data: [{ id: { invalid: true } }] })); return; }
	if (req.url === '/empty/models') { res.end(JSON.stringify({ data: [] })); return; }
	if (req.url === '/bad-json/models') { res.end('not JSON'); return; }
	if (req.url === '/google/models') { res.end(JSON.stringify({ models: [{ name: 'models/gemini-test', inputTokenLimit: 65536, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-test', supportedGenerationMethods: ['embedContent'] }] })); return; }
	res.end(JSON.stringify({ data: [{ id: 'fixture', context_length: 64000, max_output_tokens: 4000 }, { id: 'discovered', context_length: 100000, max_output_tokens: 7000 }, { id: 'discovered' }, { id: 'unknown-default' }, { id: 'embed-only', output_modalities: ['embedding'] }] }));
});
const wait = async fn => { for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Timed out'); };
try {
	const port = await listenIsolated(server), base = `http://127.0.0.1:${port}`;
	const path = join(agent, 'models.yml');
	writeFileSync(path, JSON.stringify({ providers: {
		fixture: { api: 'anthropic-messages', baseUrl: `${base}/catalog`, apiKey: 'SAVED_SECRET', headers: { 'X-Catalog': 'HEADER_SECRET' }, models: [{ id: 'fixture', name: 'Keep my name', contextWindow: 200000, maxTokens: 128000, reasoning: false }, { id: 'saved-embedding', kind: 'embedding', api: 'openai-embeddings' }] },
		dynamic: { api: 'openai-completions', baseUrl: `${base}/dynamic`, apiKey: 'DYNAMIC_SECRET', discovery: { type: 'openai-models-list', injectV1: false } },
	} }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	client = new OmpClientSession('catalog', root, new ClientStateStore(join(root, 'client-state.json')));
	client.attachSink(event => events.push(event), false);
	await client.initialize(); await client.setModel('fixture/fixture');
	const first = client.conversationId, otherSession = client.session;
	await client.newChat();
	const action = async (type, payload, resultType) => {
		const id = ++reqId;
		await client.handle({ type, reqId: id, ...payload });
		const matches = events.filter(event => event.type === resultType && event.reqId === id);
		assert.equal(matches.length, 1, `one correlated ${resultType}`);
		return matches[0];
	};
	const beforeProbe = readFileSync(path, 'utf8');
	const fetched = await action('fetch_models', { baseUrl: `${base}/catalog`, api: 'anthropic-messages', apiKey: 'DRAFT_SECRET' }, 'fetch_models_result');
	assert(fetched.ok, JSON.stringify(fetched));
	assert.deepEqual(fetched.models.map(model => model.id), ['discovered', 'fixture', 'unknown-default']);
	assert.equal(fetched.models.find(model => model.id === 'discovered').maxTokens, 7000);
	assert.equal(requests.findLast(request => request.url === '/catalog/models').headers['x-api-key'], 'DRAFT_SECRET');
	assert.equal(readFileSync(path, 'utf8'), beforeProbe, 'draft discovery never writes config');
	const noAuth = await action('fetch_models', { baseUrl: `${base}/no-auth`, apiKey: 'DO_NOT_SEND', authHeader: false }, 'fetch_models_result');
	assert(noAuth.ok); assert.equal(requests.findLast(request => request.url === '/no-auth/models').headers.authorization, undefined);
	const fallback = await action('fetch_models', { baseUrl: `${base}/fallback`, apiKey: 'BEARER_SECRET' }, 'fetch_models_result');
	assert(fallback.ok); assert.equal(requests.findLast(request => request.url === '/fallback/v1/models').headers.authorization, 'Bearer BEARER_SECRET');
	const google = await action('fetch_models', { baseUrl: `${base}/google`, api: 'google-generative-ai', apiKey: 'GOOGLE_SECRET' }, 'fetch_models_result');
	assert(google.ok); assert.deepEqual(google.models.map(model => model.id), ['gemini-test']);
	assert.equal(google.models[0].maxTokens, 8192);
	assert.equal(requests.findLast(request => request.url === '/google/models').headers['x-goog-api-key'], 'GOOGLE_SECRET');
	for (const endpoint of ['denied', 'redirect', 'invalid', 'huge', 'empty', 'bad-json']) {
		const result = await action('fetch_models', { baseUrl: `${base}/${endpoint}`, apiKey: 'PRIVATE_PROBE_KEY' }, 'fetch_models_result');
		assert.equal(result.ok, false, endpoint); assert(result.error);
		if (endpoint === 'denied') assert(result.error.includes('401'));
	}
	assert(!requests.some(request => request.url === '/credential-sink'));
	const count = requests.length;
	for (const baseUrl of ['', 'not-a-url', 'file:///private/config', 'https://user:password@host', `${base}/catalog?key=SECRET`]) assert.equal((await action('fetch_models', { baseUrl }, 'fetch_models_result')).ok, false);
	assert.equal(requests.length, count);
	const parallel = await Promise.all([
		action('fetch_models', { baseUrl: `${base}/google`, api: 'google-generative-ai' }, 'fetch_models_result'),
		action('fetch_models', { baseUrl: `${base}/catalog`, api: 'openai-responses' }, 'fetch_models_result'),
	]);
	assert(parallel.every(result => result.ok));
	assert.deepEqual(parallel[0].models.map(model => model.id), ['gemini-test']);
	assert(parallel[1].models.some(model => model.id === 'discovered'));
	const refreshed = await action('refresh_provider_models', { providerId: 'fixture' }, 'refresh_provider_result');
	assert(refreshed.ok, JSON.stringify(refreshed)); assert.equal(refreshed.added, 2); assert.equal(refreshed.total, 3);
	const request = requests.findLast(request => request.url === '/catalog/models');
	assert.equal(request.headers['x-api-key'], 'SAVED_SECRET'); assert.equal(request.headers['x-catalog'], 'HEADER_SECRET');
	const configured = (await client.session.command('harness_models_config')).data.providers.find(provider => provider.providerId === 'fixture');
	assert.equal(configured.models.find(model => model.id === 'fixture').name, 'Keep my name');
	assert.equal(configured.models.find(model => model.id === 'fixture').maxTokens, 128000);
	assert.equal(configured.nonChatModelCount, 1); assert(!configured.models.some(model => model.id === 'saved-embedding' || model.id === 'embed-only'));
	assert(readFileSync(path, 'utf8').includes('saved-embedding'), 'native non-chat entry retained');
	assert(otherSession.state.models.some(model => model.provider === 'fixture' && model.id === 'discovered'), 'other idle worker refreshes');
	const again = await action('refresh_provider_models', { providerId: 'fixture' }, 'refresh_provider_result');
	assert(again.ok); assert.equal(again.added, 0);
	await client.session.command('harness_save_provider', { providerId: 'fixture', config: { ...configured, models: configured.models.map(({ maxTokens, ...model }) => model) } });
	assert.equal((await action('refresh_provider_models', { providerId: 'fixture' }, 'refresh_provider_result')).ok, true);
	const defaults = (await client.session.command('harness_models_config')).data.providers.find(provider => provider.providerId === 'fixture');
	assert(defaults.models.every(model => model.maxTokens === undefined), 'refresh does not reintroduce cleared output overrides');
	assert.equal(defaults.nonChatModelCount, 1, 'editing chat rows preserves native kinds');
	assert.equal(otherSession.state.model.maxTokens, 16384, 'native custom-model default remains active');
	rejectSaved = true;
	const beforeFailure = readFileSync(path, 'utf8');
	assert.equal((await action('refresh_provider_models', { providerId: 'fixture' }, 'refresh_provider_result')).ok, false);
	assert.equal(readFileSync(path, 'utf8'), beforeFailure, 'failed refresh preserves config'); rejectSaved = false;
	const dynamic = await action('refresh_provider_models', { providerId: 'dynamic' }, 'refresh_provider_result');
	assert(dynamic.ok, JSON.stringify(dynamic)); assert.equal(dynamic.total, 3);
	assert(requests.some(request => request.url === '/dynamic/models' && request.headers.authorization === 'Bearer DYNAMIC_SECRET'));
	const beforeClone = readFileSync(path, 'utf8');
	const cloned = await action('clone_provider', { provider: 'anthropic' }, 'clone_provider_result');
	assert(cloned.ok, JSON.stringify(cloned)); assert(cloned.config.models.length > 0); assert.equal(cloned.config.api, 'anthropic-messages');
	assert.equal(cloned.config.apiKey, undefined); assert.equal(cloned.config.headers, undefined);
	assert.equal(readFileSync(path, 'utf8'), beforeClone, 'clone remains a draft');
	await client.session.command('harness_save_provider', { providerId: cloned.config.providerId, config: { ...cloned.config, apiKey: 'NEW_KEY' } });
	const secondClone = await action('clone_provider', { provider: 'anthropic' }, 'clone_provider_result');
	assert(secondClone.ok); assert.notEqual(secondClone.config.providerId, cloned.config.providerId);
	assert.equal((await action('clone_provider', { provider: 'missing-provider' }, 'clone_provider_result')).ok, false);
	// A request retains its originating worker while the user changes conversation.
	const pending = action('fetch_models', { baseUrl: `${base}/hold` }, 'fetch_models_result');
	await wait(() => releaseHeld); await client.switchConversation(first); releaseHeld();
	assert((await pending).ok); assert.equal(client.conversationId, first);
	assert(!/SAVED_SECRET|HEADER_SECRET|DRAFT_SECRET|DYNAMIC_SECRET|SECRET_FROM_ERROR_BODY|PRIVATE_PROBE_KEY|NEW_KEY/.test(JSON.stringify(events)), 'credentials never enter browser messages');
	console.log('PASS OMP catalog: correlated product actions, native discovery/defaults, auth/headers, merge and failure preservation, idle worker sync, safe clone drafts and navigation');
} finally {
	releaseHeld?.(); await client?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
}
