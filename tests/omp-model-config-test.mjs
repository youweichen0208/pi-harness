/** Real independent OMP workers sharing one native model configuration. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOmpTestModule } from './lib/omp-runtime-location.mjs';
const { OmpSession } = await loadOmpTestModule('session.js');
import { listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const root = mkdtempSync(join(tmpdir(), 'omp-config-')), agent = join(root, 'omp', 'agent');
mkdirSync(agent, { recursive: true });
const requests = [], sessions = [];
const env = testEnv();
for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|^ANTHROPIC_|^OPENAI_/.test(key)) delete env[key];
const server = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	requests.push({ url: req.url, key: req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, ''), body: JSON.parse(raw) });
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event('message_start', { message: { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
	event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
	event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'done' } });
	event('content_block_stop', { index: 0 });
	event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
	event('message_stop', {}); res.end();
});
const wait = async fn => { for (let i = 0; i < 800; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); } throw Error('Timed out'); };
try {
	const port = await listenIsolated(server);
	const config = { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}/old`, apiKey: 'SECRET_INITIAL', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 200000, maxTokens: 128000, input: ['text'] }] };
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { ...config, headers: { 'X-Sentinel': 'PRESERVE_HEADER' } } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false } }));
	for (const id of ['a', 'b']) {
		const session = new OmpSession({ conversationId: id, dataDir: root, cwd: root, model: 'fixture/fixture', env, restricted: { systemPrompt: 'Reply briefly.', toolNames: [] }, onChange() {} });
		sessions.push(session); await session.open();
	}
	const [a, b] = sessions;
	await Promise.all([
		a.command('harness_save_provider', { providerId: 'alpha', config }),
		b.command('harness_save_provider', { providerId: 'beta', config }),
	]);
	const view = (await a.command('harness_models_config')).data.providers;
	assert.deepEqual(view.map(p => p.providerId).sort(), ['alpha', 'beta', 'fixture']);
	assert(!JSON.stringify(view).includes('SECRET_INITIAL'));
	const updated = { ...config, baseUrl: `http://127.0.0.1:${port}/new`, apiKey: '', models: config.models.map(m => ({ ...m, name: 'Updated' })) };
	await a.command('harness_save_provider', { providerId: 'fixture', config: updated });
	assert.equal(b.state.model.name, 'Updated');
	assert(readFileSync(join(agent, 'models.yml'), 'utf8').includes('PRESERVE_HEADER'));
	await b.prompt('Use updated gateway'); await wait(() => !b.state.running);
	assert.equal(new URL(requests.at(-1).url, 'http://fixture').pathname, '/new/v1/messages');
	assert.equal(requests.at(-1).key, 'SECRET_INITIAL');
	assert.equal(requests.at(-1).body.max_tokens, 128000);
	// Clearing the editor field removes the override; the SDK chooses its default.
	const nativeDefaults = { ...updated, models: updated.models.map(({ maxTokens, ...model }) => model) };
	await a.command('harness_save_provider', { providerId: 'fixture', config: nativeDefaults });
	assert.equal((await a.command('harness_models_config')).data.providers.find(p => p.providerId === 'fixture').models[0].maxTokens, undefined);
	assert.equal(b.state.model.maxTokens, 16384, 'OMP custom-model fallback, not a host-wide constant');
	await b.prompt('Use OMP output default'); await wait(() => !b.state.running);
	assert.equal(requests.at(-1).body.max_tokens, 16384, 'actual wire output follows the native model default');
	const before = readFileSync(join(agent, 'models.yml'), 'utf8');
	await assert.rejects(a.command('harness_save_provider', { providerId: 'fixture', config: { ...updated, api: 'INVALID_PROTOCOL' } }));
	assert.equal(readFileSync(join(agent, 'models.yml'), 'utf8'), before);
	await a.command('harness_set_key', { providerId: 'fixture', apiKey: 'SECRET_REPLACED' });
	await b.prompt('Use new key'); await wait(() => !b.state.running);
	assert.equal(requests.at(-1).key, 'SECRET_REPLACED');
	const beforeAuth = readFileSync(join(agent, 'models.yml'), 'utf8');
	await a.command('harness_set_key', { providerId: 'anthropic', apiKey: 'STORED_SECRET' });
	assert.equal(readFileSync(join(agent, 'models.yml'), 'utf8'), beforeAuth, 'Built-in keys belong to native credential storage');
	assert(b.state.models.some(model => model.provider === 'anthropic'), 'Other workers reload the shared native credential store');
	const status = (await b.command('harness_providers')).data.providers.find(provider => provider.id === 'anthropic');
	assert.equal(status.source, 'stored'); assert.equal(status.configured, true);
	assert(!JSON.stringify(status).includes('STORED_SECRET'));
	await a.command('harness_clear_key', { providerId: 'anthropic' });
	assert(!b.state.models.some(model => model.provider === 'anthropic'));
	assert.equal((await b.command('harness_providers')).data.providers.find(provider => provider.id === 'anthropic').configured, false);
	assert.equal(readFileSync(join(agent, 'models.yml'), 'utf8'), beforeAuth);
	await a.command('harness_delete_provider', { providerId: 'fixture' });
	assert.equal(b.state.model, undefined);
	const count = requests.length, failed = [];
	const unsubscribe = b.subscribe(frame => { if (frame.type === 'prompt_result') failed.push(frame); });
	try {
		// Native RPC acknowledges admission before reporting a missing model.
		// Verify the actual failed outcome rather than requiring a host-side throw.
		await b.prompt('Must not dispatch');
		await wait(() => failed.some(frame => frame.status === 'error') && !b.state.running);
		assert(b.state.error, 'native failure must remain visible, never appear as successful completion');
		assert.equal(requests.length, count, 'missing model cannot dispatch to the removed provider');
	} finally { unsubscribe(); }
	console.log('PASS OMP config: concurrent writers, native rollback, explicit limits and native defaults, idle refresh, native stored-key save/clear across workers, provider deletion and next-request gateway/key');
} finally { await Promise.allSettled(sessions.map(s => s.close())); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
