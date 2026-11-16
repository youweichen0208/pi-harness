/** Retained host regression: OMP owns models.yml; cross-client imports and the
 * Pi-wide 128000 output override are retired. Real main/Wiki workers share
 * configuration without changing an in-flight multi-turn task. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { startIsolatedHarness, listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
import { mergeSnapshot } from './lib/snapshots.mjs';

const root = mkdtempSync(join(tmpdir(), 'omp-model-sources-'));
const data = join(root, 'data'), cwd = join(root, 'work'), agent = join(data, 'omp/agent');
for (const dir of [cwd, agent]) mkdirSync(dir, { recursive: true });
writeFileSync(join(cwd, 'fixture.txt'), 'ROTATION_TOOL_RESULT');
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ model: 'fixture/example', skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false } }));
const configPath = join(agent, 'models.yml'), externalPath = join(root, 'opencode.json');
const requests = [], clients = [], allFrames = [];
let harness, browser, pending, logs = '';
const onOutput = chunk => { logs += chunk; };
const endpoint = createServer(async (req, res) => {
	let raw = ''; for await (const part of req) raw += part;
	const body = JSON.parse(raw), index = requests.length;
	requests.push({ key: req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, ''), url: req.url, header: req.headers['x-preserved'], body });
	const finish = () => {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
		const tool = index === 0, name = body.tools?.find(item => /^_?read$/.test(item.name))?.name;
		emit('message_start', { message: { id: `reply-${index}`, type: 'message', role: 'assistant', model: 'example', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
		emit('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: 'rotation-read', name: name ?? 'MISSING_READ_TOOL', input: {} } : { type: 'text', text: '' } });
		for (const text of tool ? ['{"path":', '"fixture.txt"}'] : [`REPLY_${index}`]) emit('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: text } : { type: 'text_delta', text } });
		emit('content_block_stop', { index: 0 });
		emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
		emit('message_stop', {}); res.end();
	};
	if (index === 0) pending = finish; else finish();
});
async function wait(predicate, label) {
	const end = Date.now() + 30000;
	while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(25); }
	throw Error(`Timeout: ${label}; calls=${requests.length}; notices=${JSON.stringify(allFrames.filter(frame => frame.type === 'notice'))}`);
}
async function connect(clientId, fields = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	const client = { ws, events: [], state: undefined, send: message => ws.send(JSON.stringify(message)) }; clients.push(client);
	ws.on('message', raw => { const event = JSON.parse(raw); client.events.push(event); allFrames.push(event); client.state = mergeSnapshot(client.state, event); });
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	client.send({ type: 'hello', clientId, ...fields });
	await wait(() => client.events.some(event => event.type === 'ready') && client.state, 'ready');
	if (client.state.model?.id !== 'example') client.send({ type: 'set_model', modelId: 'fixture/example' });
	await wait(() => client.state.model?.id === 'example', 'selected native model');
	return client;
}
async function action(client, message, responseType) {
	const start = client.events.length; client.send(message);
	return wait(() => client.events.slice(start).find(event => event.type === responseType), responseType);
}
async function save(client, config) {
	const response = await action(client, { type: 'save_model_config', providerId: 'fixture', config }, 'models_config');
	return response.providers.find(provider => provider.providerId === 'fixture');
}
function prompt(client, text) {
	const requestId = randomUUID();
	client.send({ type: 'prompt', text, requestId, target: { cwd, conversationId: client.state.conversationId, sessionId: client.state.sessionId } });
	return requestId;
}
async function settled(client, index, requestId) {
	await wait(() => !client.state.isStreaming && client.state.messages.some(message => message.role === 'assistant' && message.content.some(block => block.text === `REPLY_${index}`)), `settled reply ${index}`);
	await wait(() => client.events.some(event => event.type === 'prompt_result' && event.requestId === requestId && event.receipt === 'accepted'), 'accepted receipt');
}
async function run(client, text, expectedKey, expectedLimit, expectedPath = '/new/v1/messages') {
	const index = requests.length, requestId = prompt(client, text); await settled(client, index, requestId);
	assert.equal(requests.length, index + 1); assert.equal(requests[index].key, expectedKey);
	assert.equal(new URL(requests[index].url, 'http://fixture').pathname, expectedPath); assert.equal(requests[index].body.max_tokens, expectedLimit);
	assert.equal(requests[index].body.model, 'example'); assert.equal(requests[index].header, 'PRESERVED');
}
try {
	const port = await listenIsolated(endpoint);
	const config = { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}/old`, apiKey: 'FIRST_SECRET', models: [{ id: 'example', name: 'Native fixture', input: ['text'], contextWindow: 200000 }] };
	writeFileSync(configPath, JSON.stringify({ preservedTopLevel: 'KEEP', providers: { fixture: { ...config, headers: { 'X-Preserved': 'PRESERVED' } } } }));
	const external = JSON.stringify({ provider: { external: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${port}/external`, apiKey: 'EXTERNAL_SECRET' }, models: { external: {} } } } });
	writeFileSync(externalPath, external);
	const env = testEnv({ PI_WEB_DATA_DIR: data, PI_WEB_CWD: cwd, OPENCODE_CONFIG: externalPath });
	for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
	harness = await startIsolatedHarness({ env, onOutput });
	let main = await connect('model-native-main'), wiki = await connect('model-native-wiki', { wiki: true, wikiCwd: cwd });
	assert.equal(wiki.state.wiki, true); assert.equal(main.state.wiki, false);
	assert.notEqual(main.state.conversationId, wiki.state.conversationId);
	for (const client of [main, wiki]) {
		const catalog = await action(client, { type: 'list_models' }, 'models');
		assert.deepEqual(catalog.models.map(model => model.id), ['fixture/example'], 'no automatic external-provider import');
		const view = await action(client, { type: 'list_models_config' }, 'models_config');
		assert.equal(view.providers[0].models[0].maxTokens, undefined, 'absence of override is visible in the editor');
		assert.equal(view.sources, undefined, 'no legacy source-sync facade');
	}
	const beforeLegacy = readFileSync(configPath, 'utf8');
	const legacy = await action(wiki, { type: 'sync_model_sources' }, 'notice');
	assert.equal(legacy.level, 'error'); assert.equal(readFileSync(configPath, 'utf8'), beforeLegacy);
	const firstId = prompt(main, 'MAIN_FIRST: read fixture.txt and answer');
	await wait(() => pending && main.state.isStreaming, 'held main model request');
	assert.equal(requests[0].key, 'FIRST_SECRET'); assert.equal(requests[0].body.max_tokens, 16384);
	assert(requests[0].body.tools.some(tool => /^_?read$/.test(tool.name)), 'use the actual native tool declaration');
	const rotated = { ...config, baseUrl: `http://127.0.0.1:${port}/new`, apiKey: 'SECOND_SECRET', models: config.models.map(model => ({ ...model, name: 'Rotated fixture' })) };
	const busy = await action(main, { type: 'save_model_config', providerId: 'fixture', config: rotated }, 'notice');
	assert.equal(busy.level, 'error'); assert.equal(readFileSync(configPath, 'utf8'), beforeLegacy, 'busy owner cannot change its active config');
	await save(wiki, rotated);
	assert.equal(main.state.isStreaming, true); assert.equal(requests.length, 1, 'saving on Wiki cannot restart the running task');
	pending(); pending = undefined;
	await settled(main, 1, firstId);
	assert.equal(requests.length, 2); assert.equal(requests[1].key, 'FIRST_SECRET', 'tool follow-up retains the in-flight credential');
	assert.equal(requests[1].url, requests[0].url, 'tool follow-up retains the in-flight gateway and native query parameters');
	assert.equal(new URL(requests[1].url, 'http://fixture').pathname, '/old/v1/messages');
	assert.equal(requests[1].body.max_tokens, 16384);
	assert(JSON.stringify(requests[1].body.messages).includes('ROTATION_TOOL_RESULT'), 'actual tool result returns to the model');
	const sessionId = main.state.sessionId, sessionFile = main.state.sessionFile;
	await run(main, 'MAIN_SECOND: continue the same history', 'SECOND_SECRET', 16384);
	assert.equal(main.state.sessionId, sessionId); assert.equal(main.state.sessionFile, sessionFile);
	assert(JSON.stringify(requests[2].body.messages).includes('MAIN_FIRST'));
	assert(JSON.stringify(requests[2].body.messages).includes('ROTATION_TOOL_RESULT'));
	await run(wiki, 'WIKI_FIRST: independent history', 'SECOND_SECRET', 16384);
	assert(!JSON.stringify(requests[3].body.messages).includes('MAIN_FIRST'), 'shared config never merges histories');
	const explicit = { ...rotated, apiKey: '', models: rotated.models.map(model => ({ ...model, maxTokens: 128000 })) };
	assert.equal((await save(wiki, explicit)).models[0].maxTokens, 128000);
	await run(main, 'MAIN_EXPLICIT: respect an explicit output limit', 'SECOND_SECRET', 128000);
	assert.equal((await save(main, { ...rotated, apiKey: '' })).models[0].maxTokens, undefined);
	await run(wiki, 'WIKI_DEFAULT: cleared override follows OMP', 'SECOND_SECRET', 16384);
	const beforeInvalid = readFileSync(configPath, 'utf8');
	const invalid = await action(wiki, { type: 'save_model_config', providerId: 'fixture', config: { ...rotated, api: 'INVALID_PROTOCOL' } }, 'notice');
	assert.equal(invalid.level, 'error'); assert.equal(readFileSync(configPath, 'utf8'), beforeInvalid, 'invalid config rolls back byte-for-byte');
	for (const client of clients) client.ws.terminate();
	await harness.stop();
	harness = await startIsolatedHarness({ env, onOutput }); main = await connect('model-native-main');
	assert.equal(main.state.sessionId, sessionId); assert.equal(main.state.sessionFile, sessionFile);
	await run(main, 'MAIN_RESTART: use saved configuration and history', 'SECOND_SECRET', 16384);
	assert(JSON.stringify(requests[6].body.messages).includes('MAIN_FIRST'));
	assert(JSON.stringify(requests[6].body.messages).includes('ROTATION_TOOL_RESULT'));
	assert(!JSON.stringify(requests[6].body.messages).includes('WIKI_FIRST'));
	if (process.argv.includes('--browser')) {
		const { chromium } = await import('playwright-core'); const { CHROME_PATH } = await import('./lib/chrome.mjs');
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath(), headless: true });
		const page = await browser.newPage(), errors = [], browserEvents = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('websocket', socket => socket.on('framereceived', ({ payload }) => { const event = JSON.parse(String(payload)); browserEvents.push(event); allFrames.push(event); }));
		await page.goto(`http://127.0.0.1:${harness.port}`);
		await wait(() => browserEvents.some(event => event.type === 'ready'), 'browser ready');
		const openManager = async () => {
			await page.locator('.input-tools button.chip').filter({ has: page.locator('.chip-model') }).click();
			await page.getByRole('button', { name: /管理模型|Manage models/i }).click();
			await page.locator('.model-modal').waitFor();
		};
		await openManager();
		const modal = page.locator('.model-modal');
		assert((await modal.innerText()).includes('OMP 默认值'));
		assert(!/恢复同步|models\.json/.test(await modal.innerText()));
		assert.equal(await modal.getByRole('region', { name: /配置来源|Configuration sources/ }).count(), 0);
		const edit = async () => {
			await wait(() => browserEvents.some(event => event.type === 'models_config' && event.providers.some(provider => provider.providerId === 'fixture')), 'browser model list');
			await modal.locator('.provider-list').first().locator('.provider-row').filter({ hasText: 'fixture' }).getByTitle(/编辑|Edit/).click();
		};
		await edit();
		const limit = modal.getByRole('spinbutton', { name: /最大输出|Max output/ });
		assert.equal(await limit.inputValue(), '');
		assert.equal(await modal.locator('input[type=password]').inputValue(), '', 'stored key never fills the editor');
		const uiSave = async value => {
			await limit.fill(value); const start = browserEvents.length;
			await modal.getByRole('button', { name: /^(保存|Save)$/ }).click();
			const result = await wait(() => browserEvents.slice(start).find(event => event.type === 'models_config'), 'browser config save');
			assert.equal(result.providers.find(provider => provider.providerId === 'fixture').models[0].maxTokens, value ? Number(value) : undefined);
			await openManager(); await edit(); assert.equal(await limit.inputValue(), value);
		};
		await uiSave('128000'); await uiSave('');
		mkdirSync('tests/scratch', { recursive: true });
		await page.screenshot({ path: 'tests/scratch/omp-model-config.png', animations: 'disabled' });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.screenshot({ path: 'tests/scratch/omp-model-config-narrow.png', animations: 'disabled' });
		assert(await modal.evaluate(node => node.getBoundingClientRect().left >= 0 && node.getBoundingClientRect().right <= innerWidth), 'model editor fits narrow viewport');
		await modal.locator('.modal-close').click();
		await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en'));
		const start = browserEvents.length; await page.reload();
		await wait(() => browserEvents.slice(start).some(event => event.type === 'ready'), 'English browser ready');
		await openManager();
		assert((await modal.innerText()).includes('Leave max output blank to use the OMP default.'));
		assert(!/Restore sync|models\.json/.test(await modal.innerText()));
		await edit(); assert.equal(await limit.inputValue(), '');
		await page.screenshot({ path: 'tests/scratch/omp-model-config-en.png', animations: 'disabled' });
		assert.deepEqual(errors, []);
	}
	assert.equal(requests.length, 7, 'configuration changes and UI actions do not call the model');
	if (browser) await run(main, 'MAIN_AFTER_FORM: use the saved browser configuration', 'SECOND_SECRET', 16384);
	assert.equal(readFileSync(externalPath, 'utf8'), external, 'external config is untouched');
	assert(!existsSync(join(data, 'model-sources.json')), 'no legacy source catalogue is created');
	assert(readFileSync(configPath, 'utf8').includes('preservedTopLevel: KEEP'));
	for (const secret of ['FIRST_SECRET', 'SECOND_SECRET', 'EXTERNAL_SECRET']) {
		assert(!JSON.stringify(allFrames).includes(secret), 'server frames never disclose credentials');
		assert(!logs.includes(secret), 'server logs never disclose credentials');
		assert(!readFileSync(sessionFile, 'utf8').includes(secret), 'native history never contains credentials');
		assert(!readFileSync(join(data, 'client-state.json'), 'utf8').includes(secret), 'host state never contains credentials');
		for (const file of readdirSync(join(data, 'omp/clients'))) if (file.endsWith('.json')) assert(!readFileSync(join(data, 'omp/clients', file), 'utf8').includes(secret), 'per-client OMP state never contains credentials');
	}
	console.log('PASS OMP host model config: main/Wiki, busy rejection, in-flight tool credential/gateway isolation, next-request rotation, native defaults and explicit/cleared limits, rollback, restart/history, retired external sync, secret isolation' + (browser ? ', browser save/reopen and narrow viewport' : ''));
} finally {
	await browser?.close(); for (const client of clients) client.ws.terminate(); await harness?.stop();
	endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve)); rmSync(root, { recursive: true, force: true });
}
