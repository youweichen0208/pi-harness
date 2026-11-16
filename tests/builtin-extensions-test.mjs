/** OMP application database capability; native resources replace the retired Pi built-in inventory. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { mergeSnapshot } from './lib/snapshots.mjs';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-db-'))), data = join(root, 'data'), agent = join(data, 'omp/agent'), cwd = join(root, 'work');
for (const dir of [cwd, join(agent, 'extensions')]) mkdirSync(dir, { recursive: true });
const settingsFile = join(data, 'document-extensions.json'), counter = join(root, 'worker-opens.txt'), token = 'local-settings-fixture';
const clients = [], requests = [], withBrowser = process.argv.includes('--browser');
let harness, browser, nextCall, holdNext = false, release;
const wait = async (predicate, label) => { for (let i = 0; i < 800; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error(`Timed out ${label}\n${harness?.logs ?? ''}`); };
const provider = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk; const payload = JSON.parse(raw); requests.push(payload);
	if (holdNext) { holdNext = false; await new Promise(resolve => { release = resolve; res.once('close', resolve); }); }
	if (res.destroyed) return;
	const call = nextCall; nextCall = undefined;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `m-${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
	emit('content_block_start', { index: 0, content_block: call ? { type: 'tool_use', id: call, name: payload.tools.find(tool => /^(?:_)?database_read$/.test(tool.name)).name, input: {} } : { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: call ? { type: 'input_json_delta', partial_json: '{"action":"list"}' } : { type: 'text_delta', text: 'Fixture finished.' } });
	emit('content_block_stop', { index: 0 });
	emit('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
	emit('message_stop', {}); res.end();
});
async function connect(id) {
	const client = { id, wire: [], state: undefined, ws: new WebSocket(`ws://127.0.0.1:${harness.port}/ws?token=${token}`) }; clients.push(client);
	client.send = message => client.ws.send(JSON.stringify(message));
	client.ws.on('message', raw => { const event = JSON.parse(raw); client.wire.push(event); client.state = mergeSnapshot(client.state, event); });
	await new Promise((resolve, reject) => { client.ws.once('open', resolve); client.ws.once('error', reject); });
	client.send({ type: 'hello', clientId: id }); await wait(() => client.wire.some(event => event.type === 'ready'), 'client ready');
	return client;
}
async function request(client, action, extra = {}, expected = 200, options = {}) {
	const response = await fetch(`http://127.0.0.1:${harness.port}${options.path ?? '/api/database'}${options.noToken ? '' : `?token=${token}`}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: options.origin ?? `http://127.0.0.1:${harness.port}` }, body: JSON.stringify({ clientId: client.id, cwd, conversationId: client.state.conversationId, requestId: crypto.randomUUID(), action, ...extra }) });
	if (expected !== null) assert.equal(response.status, expected);
	const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch { value = { error: raw }; }
	return expected === null ? { status: response.status, value } : value;
}
const settings = async client => (await request(client, 'agent_settings')).agentSettings;
const save = (client, state, enabled, status = 200) => request(client, 'set_agent_settings', { version: state.version, enabled }, status);
async function invoke(client, isError = false) {
	const id = `database-${requests.length}`, before = requests.length; nextCall = id;
	client.send({ type: 'prompt', text: 'Read attached database connections', requestId: crypto.randomUUID() });
	await wait(() => !client.state.isStreaming && client.state.messages.some(message => message.role === 'toolResult' && message.toolCallId === id), 'native host tool');
	assert.equal(client.state.messages.find(message => message.toolCallId === id)?.isError === true, isError);
	assert.equal(requests.length, before + 2, 'one tool round; no automatic repeat');
}
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 1000000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	writeFileSync(join(agent, 'extensions', 'counter.ts'), `import {appendFileSync} from "node:fs"; export default () => appendFileSync(${JSON.stringify(counter)}, "open\\n");`);
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_WEB_TOKEN: token } });
	const a = await connect('builtin-a'), b = await connect('builtin-b');
	const initial = await settings(a); assert.equal(initial.enabled, true); assert.match(initial.version, /^[a-f0-9]{64}$/);
	const resources = await request(a, 'omp-resources', {}, 200, { path: '/api/extensions' });
	assert(resources.tools.includes('database_read') && resources.tools.includes('task'));
	assert(!resources.tools.some(name => ['subagent', 'codemode', 'document_to_markdown', 'okf_ingest'].includes(name)), 'retired Pi and removed conversion tools cannot return');
	a.send({ type: 'get_commands' }); await wait(() => a.wire.some(event => event.type === 'slash_commands'), 'commands');
	assert(!a.wire.findLast(event => event.type === 'slash_commands').commands.some(command => ['documents', 'pdf-md', 'okf'].includes(command.name)));
	assert.equal(requests.length, 0, 'settings and inventory are metadata only');
	await invoke(a);
	await save(a, initial, false);
	assert.equal((await settings(b)).enabled, false, 'shared service setting reaches another client');
	assert.equal((await save(b, initial, true, 400)).error, 'DATABASE_AGENT_SETTINGS_CONFLICT');
	await invoke(a, true);
	await save(b, await settings(b), true); await invoke(a);
	const before = await settings(a);
	writeFileSync(settingsFile, JSON.stringify({ databaseEnabled: true, secretFuture: 'PRIVATE_SETTINGS_VALUE', pdfEnabled: true }));
	assert.equal((await save(a, before, false, 400)).error, 'DATABASE_AGENT_SETTINGS_CONFLICT');
	const external = await settings(a); assert(!JSON.stringify(external).includes('PRIVATE_SETTINGS_VALUE'));
	await save(a, external, false);
	assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), { databaseEnabled: false, secretFuture: 'PRIVATE_SETTINGS_VALUE' });
	const race = await settings(a);
	const raced = await Promise.all([save(a, race, true, null), save(b, race, true, null)]);
	assert.deepEqual(raced.map(result => result.status).sort(), [200, 400]);
	assert.equal(raced.find(result => result.status === 400).value.error, 'DATABASE_AGENT_SETTINGS_CONFLICT');
	for (const bad of [{ enabled: 'false', version: race.version }, { enabled: false, version: '' }]) assert.equal((await request(a, 'set_agent_settings', bad, 400)).error, 'DATABASE_AGENT_SETTINGS_INVALID');
	await request(a, 'agent_settings', {}, 401, { noToken: true });
	await request(a, 'agent_settings', {}, 403, { origin: 'https://untrusted.invalid' });
	await request(a, 'agent_settings', { conversationId: 'stale' }, 409);
	await request(a, 'set_agent_settings', { version: race.version, enabled: false, cwd: root }, 409);
	holdNext = true; a.send({ type: 'prompt', text: 'Held model request', requestId: 'held' });
	await wait(() => release && a.state.isStreaming, 'running request');
	await save(b, await settings(b), false);
	release(); release = undefined; await wait(() => !a.state.isStreaming, 'settled');
	await invoke(a, true);
	const previous = a.state.conversationId; a.send({ type: 'new_chat', fresh: true });
	await wait(() => a.state.conversationId !== previous && !a.state.isStreaming && a.state.tools.includes('database_read'), 'new conversation');
	assert.equal((await settings(a)).enabled, false); await invoke(a, true);
	await save(a, await settings(a), true); await invoke(a);
	const validSettings = readFileSync(settingsFile, 'utf8');
	writeFileSync(settingsFile, 'PRIVATE_BROKEN_CONFIG');
	assert.equal((await request(a, 'agent_settings', {}, 400)).error, 'DATABASE_AGENT_SETTINGS_UNAVAILABLE');
	assert.equal((await save(a, race, true, 400)).error, 'DATABASE_AGENT_SETTINGS_UNAVAILABLE');
	assert.equal(readFileSync(settingsFile, 'utf8'), 'PRIVATE_BROKEN_CONFIG');
	assert((await request(a, 'omp-resources', {}, 200, { path: '/api/extensions' })).tools.includes('task'), 'broken database setting does not disable unrelated OMP resources');
	writeFileSync(settingsFile, validSettings);
	const workerStatus = () => request(a, 'status', {}, 200, { path: '/api/omp-mcp' });
	a.send({ type: 'abort' }); await wait(async () => (await workerStatus()).workerAvailable === false, 'stopped worker');
	const opens = readFileSync(counter, 'utf8'), beforeStopReads = requests.length;
	for (const action of ['skills-list', 'builtin-list', 'builtin-toggle', 'list', 'unknown']) {
		const retired = await request(a, action, {}, null, { path: '/api/extensions' });
		assert.equal(readFileSync(counter, 'utf8'), opens, 'retired requests must not start a stopped OMP worker');
		assert.equal(retired.status, 410);
	}
	await save(a, await settings(a), false); await settings(a);
	assert.equal(readFileSync(counter, 'utf8'), opens, 'reading/saving settings must not reopen a stopped OMP worker');
	assert.equal(requests.length, beforeStopReads);
	assert.equal((await workerStatus()).workerAvailable, false);
	if (withBrowser) {
		const { chromium } = await import('playwright-core'), { CHROME_PATH } = await import('./lib/chrome.mjs');
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), other = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		const errors = []; for (const target of [page, other]) target.on('pageerror', error => errors.push(error.message));
		async function openSettings(target, id, english = false) {
			await target.addInitScript(id => { sessionStorage.setItem('pi-web-client-id', id); if (!localStorage.getItem('pi-harness:lang')) localStorage.setItem('pi-harness:lang', 'zh'); }, id);
			await target.goto(`http://127.0.0.1:${harness.port}/?token=${token}`);
			await target.getByRole('button', { name: english ? 'Settings' : '设置', exact: true }).first().click();
			await target.getByText(english ? 'All settings' : '所有设置', { exact: true }).click();
			await target.getByRole('button', { name: 'Extensions', exact: true }).click();
			await wait(async () => await target.locator('.database-agent-settings [role=switch]').isEnabled(), 'settings switch');
		}
		await openSettings(page, 'database-ui-a'); await openSettings(other, 'database-ui-b');
		const panel = page.locator('.database-agent-settings'), toggle = panel.getByRole('switch');
		assert.equal(await toggle.isChecked(), false);
		await toggle.focus(); await page.keyboard.press('Space');
		await wait(async () => await toggle.isChecked(), 'keyboard enables access');
		await wait(async () => await other.locator('.database-agent-settings [role=switch]').isChecked(), 'other window polling');
		let conflict = true;
		await page.route('**/api/database*', async route => {
			if (conflict && route.request().postDataJSON()?.action === 'set_agent_settings') { conflict = false; writeFileSync(settingsFile, JSON.stringify({ databaseEnabled: true, external: 'KEEP_EXTERNAL' })); }
			await route.continue();
		});
		await toggle.click(); await panel.getByRole('alert').waitFor();
		assert.equal(await toggle.isChecked(), true, 'failed save keeps the last confirmed value');
		assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).databaseEnabled, true);
		await panel.getByRole('button', { name: '重新读取设置' }).click();
		await wait(async () => await toggle.isEnabled(), 'conflict reload'); await toggle.click();
		await wait(async () => !await toggle.isChecked(), 'disable after explicit reload');
		assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).external, 'KEEP_EXTERNAL');
		await page.route('**/api/extensions*', async route => route.request().postDataJSON()?.action === 'omp-resources' ? route.fulfill({ status: 500, json: { error: 'Native resources fixture unavailable' } }) : route.continue());
		await openSettings(page, 'database-ui-a');
		await page.getByText('Native resources fixture unavailable', { exact: true }).waitFor();
		assert.equal(await toggle.isChecked(), false, 'database settings survive unrelated native resource failures');
		await toggle.click(); await wait(async () => await toggle.isChecked(), 'independent toggle');
		writeFileSync(settingsFile, 'PRIVATE_INVALID_SETTINGS');
		await panel.getByRole('button', { name: '重新读取设置' }).click(); await panel.getByRole('alert').waitFor();
		assert.equal(await toggle.isEnabled(), false); assert(!(await panel.innerText()).includes('PRIVATE_INVALID_SETTINGS'));
		writeFileSync(settingsFile, JSON.stringify({ databaseEnabled: false }));
		await panel.getByRole('button', { name: '重新读取设置' }).click(); await wait(async () => await toggle.isEnabled(), 'repair reread');
		await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => document.documentElement.dataset.appearance = 'dark');
		assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
		await page.screenshot({ path: join(tmpdir(), 'omp-database-settings-narrow.png') });
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.unroute('**/api/extensions*');
		await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en'));
		await openSettings(page, 'database-ui-a', true);
		assert.equal(await panel.getByRole('switch', { name: 'Allow conversations to query databases' }).isChecked(), false);
		await page.screenshot({ path: join(tmpdir(), 'omp-database-settings-en.png') });
		assert.deepEqual(errors, []);
		assert.equal(requests.length, beforeStopReads, 'settings UI never invokes a model');
	}
	await browser?.close(); browser = undefined;
	for (const client of clients) client.ws.close();
	await harness.stop();
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_WEB_TOKEN: token } });
	const restored = await connect('settings-after-restart');
	assert.equal((await settings(restored)).enabled, false, 'saved disable survives a fresh service');
	console.log('PASS OMP application database settings: native resources, active-call enforcement, version conflicts, simultaneous clients, stopped workers, corrupt settings, restart, auth and scope' + (withBrowser ? ', keyboard, cross-window polling, conflict recovery, independent errors, English and narrow layout' : ''));
} finally {
	release?.(); await browser?.close(); for (const client of clients) client.ws.close(); await harness?.stop();
	provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
