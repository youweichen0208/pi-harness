/** Public host extension contracts using real OMP modules and native settings.
 * Package installs/upgrades use omp-packages / component-updates regressions;
 * Pi package tickets, pi.dev catalogue and auto-check preferences are retired. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { mergeSnapshot } from './lib/snapshots.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-extensions-host-'))), cwd = join(root, 'work'), data = join(root, 'data'), agent = join(data, 'omp/agent');
const extensionDir = join(agent, 'extensions'), skillDir = join(root, 'skills'), counter = join(root, 'loads'), token = 'LOCAL_EXTENSION_TOKEN';
for (const dir of [cwd, extensionDir, join(skillDir, 'fixture-skill')]) mkdirSync(dir, { recursive: true });
writeFileSync(counter, '');
writeFileSync(join(skillDir, 'fixture-skill/SKILL.md'), '---\nname: fixture-skill\ndescription: A short local fixture skill.\n---\nNo external services.\n');
const source = version => `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, '${version}\\n'); export default api => api.registerCommand('host-${version}', {description:'Host extension fixture', handler:async()=>{}});`;
const file = join(extensionDir, 'host-fixture.js'); writeFileSync(file, source('v1'));
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false, customDirectories: [skillDir], enableAgentsUser: false, enableAgentsProject: false, enablePiUser: false, enablePiProject: false, enableClaudeUser: false, enableClaudeProject: false, enableCodexUser: false }, cacheWarming: { enabled: false }, secretFuture: 'KEEP_PRIVATE_CONFIG' }));
const clients = [], responses = []; let harness, browser, modelCalls = 0;
const provider = createServer((req, res) => { modelCalls++; req.resume(); res.writeHead(500); res.end('No inference expected'); });
const wait = async (predicate, label) => { for (let n = 0; n < 1000; n++) { const value = await predicate(); if (value) return value; await sleep(25); } throw Error(`Timed out: ${label}`); };
async function connect(id) {
	const client = { id, state: undefined, frames: [], ws: new WebSocket(`ws://127.0.0.1:${harness.port}/ws?token=${token}`) }; clients.push(client);
	client.send = message => client.ws.send(JSON.stringify(message));
	client.ws.on('message', raw => { const frame = JSON.parse(raw); client.frames.push(frame); client.state = mergeSnapshot(client.state, frame); });
	await new Promise((resolve, reject) => { client.ws.once('open', resolve); client.ws.once('error', reject); });
	client.send({ type: 'hello', clientId: id }); await wait(() => client.frames.some(frame => frame.type === 'ready'), 'client ready'); return client;
}
async function request(client, action, payload = {}, expected = 200, options = {}) {
	const base = `http://127.0.0.1:${harness.port}`, path = options.path ?? '/api/omp-extensions';
	const response = await fetch(`${base}${path}${options.noToken ? '' : `?token=${token}`}`, { method: 'POST', headers: { 'Content-Type': options.contentType ?? 'application/json', Origin: options.origin ?? base }, body: JSON.stringify({ clientId: client.id, cwd, conversationId: client.state.conversationId, action, ...payload }) });
	assert.equal(response.status, expected, `${path} ${action}`); const raw = await response.text(); let result; try { result = JSON.parse(raw); } catch { result = { error: raw }; }
	responses.push(result); return result;
}
const resources = client => request(client, 'omp-resources', {}, 200, { path: '/api/extensions' });
async function commands(client) {
	const start = client.frames.length; client.send({ type: 'get_commands' });
	const frame = await wait(() => client.frames.slice(start).find(frame => frame.type === 'slash_commands'), 'commands'); return frame.commands.map(command => command.name);
}
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'PRIVATE_MODEL_KEY', models: [{ id: 'fixture' }] } } }));
	const executable = process.argv.includes('--electron-node') ? (await import('electron')).default : process.execPath;
	harness = await startIsolatedHarness({ executable, env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_WEB_TOKEN: token, ...(process.argv.includes('--electron-node') ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
	const a = await connect('extensions-a'), b = await connect('extensions-b');
	for (const options of [{ noToken: true }, { origin: 'https://foreign.example' }, { contentType: 'text/plain' }]) await request(a, 'get', {}, options.noToken ? 401 : 403, options);
	for (const payload of [{ clientId: 'foreign' }, { cwd: root }, { conversationId: b.state.conversationId }]) await request(a, 'get', payload, 409);
	const initialLoads = readFileSync(counter, 'utf8');
	const views = await Promise.all(Array.from({ length: 8 }, () => request(a, 'get')));
	let view = views[0], module = view.modules.find(module => module.name === 'host-fixture'); assert(module?.active && module.editable);
	assert.equal(readFileSync(counter, 'utf8'), initialLoads, 'parallel metadata reads never import factories');
	const sessionId = a.state.sessionId, sessionFile = a.state.sessionFile, original = await request(a, 'read-file', { moduleId: module.id });
	assert.equal(original.content, source('v1'));
	await request(a, 'read-file', { moduleId: '../config.yml' }, 400);
	await request(a, 'save-file', { moduleId: module.id, version: 'stale', content: 'bad' }, 400);
	const writes = await Promise.all([a, b].map(async (client, i) => {
		const res = await fetch(`http://127.0.0.1:${harness.port}/api/omp-extensions?token=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: client.id, cwd, conversationId: client.state.conversationId, action: 'save-file', moduleId: module.id, version: original.version, content: source(`writer${i}`) }) });
		return res.status;
	}));
	assert.deepEqual(writes.sort(), [200, 400], 'two clients cannot overwrite one source version');
	const current = await request(a, 'read-file', { moduleId: module.id });
	await request(a, 'save-file', { moduleId: module.id, version: current.version, content: source('v2') });
	assert.equal(readFileSync(file, 'utf8'), source('v2')); assert.equal(readFileSync(counter, 'utf8'), initialLoads);
	assert((await commands(a)).includes('host-v1')); assert(!(await commands(a)).includes('host-v2'));
	view = await request(a, 'get'); const staleVersion = view.version;
	await request(a, 'toggle', { version: view.version, moduleId: module.id, enabled: false });
	await wait(async () => !(await commands(a)).includes('host-v1'), 'disabled current extension');
	await wait(async () => !(await commands(b)).includes('host-v1'), 'shared setting reaches idle peer');
	await request(b, 'toggle', { version: staleVersion, moduleId: module.id, enabled: true }, 400);
	view = await request(a, 'get'); await request(a, 'toggle', { version: view.version, moduleId: module.id, enabled: true });
	await wait(async () => (await commands(a)).includes('host-v1'), 'resume loaded extension');
	assert.equal(readFileSync(counter, 'utf8'), initialLoads, 'suspend/resume does not execute saved source');
	await request(a, 'restart'); await wait(async () => (await commands(a)).includes('host-v2'), 'explicit reload loads saved source');
	assert.equal(a.state.sessionId, sessionId); assert.equal(a.state.sessionFile, sessionFile);
	assert((await commands(b)).includes('host-v1'), 'reloading one client does not restart its peer');
	const r = await resources(a); assert.equal(r.agentDir, realpathSync(agent)); assert(r.tools.includes('task'));
	assert(!r.tools.includes('subagent') && !r.tools.includes('codemode'));
	const skillView = await request(a, 'omp-save-skills', { version: r.skillSettings.version, patch: { enabled: true } }, 200, { path: '/api/extensions' });
	assert(skillView.skills.some(skill => skill.name === 'fixture-skill'));
	await request(b, 'omp-save-skills', { version: r.skillSettings.version, patch: { enabled: false } }, 400, { path: '/api/extensions' });
	const beforeRetired = readFileSync(counter, 'utf8'), beforeConfig = readFileSync(join(agent, 'config.yml'), 'utf8');
	for (const action of ['list', 'start', 'job', 'preview', 'details', 'search', 'check', 'preferences', 'file', 'save-file', 'open-info', 'skills-list', 'builtin-list']) await request(a, action, { source: root, operation: { action: 'install', source: 'arbitrary' }, content: 'bad' }, 410, { path: '/api/extensions' });
	assert.equal(readFileSync(counter, 'utf8'), beforeRetired); assert.equal(readFileSync(join(agent, 'config.yml'), 'utf8'), beforeConfig);
	if (process.argv.includes('--browser')) {
		const { chromium } = await import('playwright-core'); const { CHROME_PATH } = await import('./lib/chrome.mjs');
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath(), headless: true });
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], requests = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/extensions') requests.push(req.postDataJSON().action); });
		await page.addInitScript(id => sessionStorage.setItem('pi-web-client-id', id), a.id);
		await page.goto(`http://127.0.0.1:${harness.port}/?token=${token}`); await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
		const openSettings = async () => { await page.getByRole('button', { name: /^(设置|Settings)$/ }).and(page.locator(':visible')).first().click(); await page.getByText(/^(所有设置|All settings)$/).click(); };
		await openSettings();
		const modal = page.locator('.settings-modal'), rail = modal.locator('.settings-rail');
		assert.equal(await rail.locator('.settings-tab.active').innerText(), '系统提示词');
		mkdirSync('tests/scratch', { recursive: true });
		for (const width of [1440, 900, 390]) {
			await page.setViewportSize({ width, height: 1000 }); let expected;
			for (const name of ['系统提示词', '外观', '技能', 'Extensions', 'OMP 工具']) {
				await rail.getByRole('button', { name, exact: true }).click();
				const boxes = await page.evaluate(() => ['.settings-modal', '.settings-rail', '.modal-body'].map(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height].map(Math.round); }));
				expected ??= boxes; assert.deepEqual(boxes, expected, `stable settings shell ${width}: ${name}`);
				const rect = await modal.boundingBox(), close = await modal.locator('> .modal-head button').boundingBox();
				assert(rect.x >= 0 && rect.x + rect.width <= width); assert(close.x > rect.x + rect.width - 90);
			}
		}
		await rail.getByRole('button', { name: 'Extensions', exact: true }).click();
		const panel = modal.locator('.omp-extension-panel'), row = panel.locator('.settings-skill-row').filter({ hasText: 'host-fixture' });
		await row.getByRole('button', { name: '编辑 host-fixture 源码', exact: true }).click();
		const editor = panel.locator('.omp-extension-editor'), text = editor.getByRole('textbox', { name: '编辑文件', exact: true });
		assert.equal(await text.inputValue(), source('v2')); await text.fill(source('browser'));
		page.once('dialog', dialog => dialog.dismiss()); await rail.getByRole('button', { name: '技能', exact: true }).click();
		assert.equal(await text.inputValue(), source('browser'), 'cancelled navigation preserves the draft');
		await editor.getByRole('button', { name: '保存文件', exact: true }).click();
		await wait(() => readFileSync(file, 'utf8') === source('browser'), 'browser source save');
		assert((await commands(a)).includes('host-v2'), 'saving does not silently reload code');
		await modal.screenshot({ path: 'tests/scratch/omp-extension-host-narrow.png', animations: 'disabled' });
		await page.setViewportSize({ width: 1440, height: 1000 });
		const controls = modal.locator('button:enabled:visible, input:enabled:visible, textarea:enabled:visible, select:enabled:visible, a[href]:visible');
		await controls.last().focus(); await page.keyboard.press('Tab'); assert(await controls.first().evaluate(node => node === document.activeElement));
		await page.keyboard.press('Shift+Tab'); assert(await controls.last().evaluate(node => node === document.activeElement));
		await modal.locator('> .modal-head button').click();
		await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en')); await page.reload(); await openSettings();
		await rail.getByRole('button', { name: 'Extensions', exact: true }).click(); await panel.getByText('host-fixture', { exact: true }).waitFor();
		assert.equal(await rail.getByRole('button', { name: /Component updates|MCP and Codemode/ }).count(), 0);
		assert(requests.every(action => ['omp-resources', 'omp-reload', 'omp-save-skills'].includes(action)), 'current settings never calls retired Pi extension actions');
		assert.deepEqual(errors, []);
		await browser.close(); browser = undefined;
	}
	a.send({ type: 'abort' }); await wait(async () => (await request(a, 'get')).available === false, 'stopped worker');
	const stoppedLoads = readFileSync(counter, 'utf8'), stoppedFile = readFileSync(file, 'utf8');
	await request(a, 'read-file', { moduleId: module.id }, 400); await request(a, 'save-file', { moduleId: module.id, version: original.version, content: 'bad' }, 400);
	await request(a, 'skills-list', {}, 410, { path: '/api/extensions' });
	assert.equal((await resources(a)).available, false); assert.equal(readFileSync(counter, 'utf8'), stoppedLoads); assert.equal(readFileSync(file, 'utf8'), stoppedFile);
	assert((await request(b, 'get')).modules.some(module => module.active), 'stopping one conversation preserves its peer');
	assert.equal(modelCalls, 0, 'metadata, editing, native settings and explicit reload never infer');
	assert(readFileSync(join(agent, 'config.yml'), 'utf8').includes('KEEP_PRIVATE_CONFIG'));
	for (const secret of ['PRIVATE_MODEL_KEY', 'KEEP_PRIVATE_CONFIG']) assert(!JSON.stringify([...responses, ...clients.flatMap(client => client.frames)]).includes(secret));
	console.log('PASS OMP extension host: auth/ownership, concurrent metadata and CAS source edits, real toggle/reload/peer isolation, skill settings, retired APIs, stopped-worker reads, zero inference' + (process.argv.includes('--browser') ? ', current settings shell/focus/drafts and zh/en narrow UI' : ''));
} finally {
	await browser?.close(); for (const client of clients) client.ws.terminate(); await harness?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
