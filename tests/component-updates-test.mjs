/** Native package updates replace Pi component updates. Real SDK operations
 * use a private local registry; the browser forwards only package HTTP to the
 * production route with that isolated runner, never the user's plugin root. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import WebSocket from 'ws';
import { startIsolatedHarness, listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
import { mergeSnapshot } from './lib/snapshots.mjs';
// This host-only test accepts --browser, unlike the packaged two-argument loader.
const { OmpPackages, createOmpPackageRunner } = await import('../dist/server/omp/packages.js');
const { installOmpRoutes } = await import('../dist/server/omp/routes.js');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-updates-'))), data = join(root, 'data'), agent = join(data, 'omp/agent');
const configRoot = join(root, 'native'), plugins = join(configRoot, 'plugins'), counter = join(root, 'imports');
for (const dir of [agent, plugins]) mkdirSync(dir, { recursive: true });
writeFileSync(counter, '');
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'fixture' }] } } }));
const name = 'omp-update-regression', archives = new Map(), wire = [], jobs = [];
for (const version of ['1.0.0', '1.1.0', '1.2.0', '2.0.0']) {
	const directory = join(root, version); mkdirSync(join(directory, 'package'), { recursive: true });
	writeFileSync(join(directory, 'package/package.json'), JSON.stringify({ name, version, type: 'module', omp: { extensions: ['./entry.js'] } }));
	writeFileSync(join(directory, 'package/entry.js'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, '${version}\\n'); ${version === '2.0.0' ? "throw Error('UPDATE_FACTORY_PRIVATE');" : 'export default api => {};'}`);
	const file = join(root, `${version}.tgz`); execFileSync('tar', ['-czf', file, '-C', directory, 'package']); archives.set(version, readFileSync(file));
}
let latest = '1.0.0', registryOrigin, hits = 0, registryFailure = false;
const registry = createServer((req, res) => {
	hits++;
	if (registryFailure) { res.writeHead(503); res.end('REGISTRY_PRIVATE'); return; }
	if (req.url === `/${name}`) {
		const versions = Object.fromEntries([...archives].map(([version, bytes]) => [version, { name, version, dist: { tarball: `${registryOrigin}/${version}.tgz`, shasum: createHash('sha1').update(bytes).digest('hex') } }]));
		res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name, 'dist-tags': { latest }, versions }));
	} else {
		const bytes = archives.get(req.url?.slice(1, -4)); if (bytes) res.end(bytes); else { res.writeHead(404); res.end(); }
	}
});
let harness, socket, browser, service, api, apiOrigin, state;
let owner = { clientId: 'updates-client', cwd: root, conversationId: '' };
const frames = [];
const wait = async (predicate, label) => { for (let n = 0; n < 1200; n++) { const value = await predicate(); if (value) return value; await sleep(25); } throw Error(`Timed out: ${label}`); };
const post = async body => {
	const response = await fetch(`${apiOrigin}/api/omp-packages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: apiOrigin }, body: JSON.stringify({ ...owner, ...body }) });
	const result = await response.json(); wire.push(result); return { status: response.status, ...result };
};
const execute = async (operation, target, phase = 'success') => {
	const plan = await post({ action: 'preview', operation, target }); assert.equal(plan.status, 200);
	const { status: _status, ...nativePlan } = plan, id = randomUUID();
	assert.equal((await post({ action: 'start', id, plan: nativePlan })).status, 200);
	const result = await wait(async () => { const value = await post({ action: 'job', id }); return value.phase !== 'running' && value; }, `${operation} job`);
	assert.equal(result.phase, phase, JSON.stringify(result)); jobs.push(result); return result;
};
try {
	registryOrigin = `http://127.0.0.1:${await listenIsolated(registry)}`;
	writeFileSync(join(plugins, '.npmrc'), `registry=${registryOrigin}\n`);
	const env = testEnv({ PI_CONFIG_DIR: relative(homedir(), configRoot), PI_CODING_AGENT_DIR: agent, BUN_INSTALL_CACHE_DIR: join(root, 'cache'), PATH: '', Path: '' });
	delete env.ELECTRON_RUN_AS_NODE; for (const key of Object.keys(env)) if (key.startsWith('OMP_')) delete env[key];
	service = new OmpPackages(data, createOmpPackageRunner(data, { env }));
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: data } });
	const health = await (await fetch(`http://127.0.0.1:${harness.port}/api/health`)).json();
	assert.equal(health.agentEngine, 'omp'); assert.equal(health.ompVersion, JSON.parse(readFileSync('node_modules/@oh-my-pi/pi-coding-agent/package.json', 'utf8')).version);
	socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	socket.on('message', raw => { const frame = JSON.parse(raw); frames.push(frame); state = mergeSnapshot(state, frame); });
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
	socket.send(JSON.stringify({ type: 'hello', clientId: owner.clientId }));
	await wait(() => frames.some(frame => frame.type === 'ready') && state, 'host ready'); owner.conversationId = state.conversationId;
	const nativeConfig = readFileSync(join(agent, 'config.yml'), 'utf8'), importsBefore = readFileSync(counter, 'utf8');
	for (const message of [{ type: 'check_component_updates', requestId: 'retired-check' }, { type: 'update_component', requestId: 'retired-agent', id: 'builtin:agent' }, { type: 'update_component', requestId: 'retired-arbitrary', id: 'npm:injected' }]) {
		const start = frames.length; socket.send(JSON.stringify(message));
		const result = await wait(() => frames.slice(start).find(frame => frame.type === 'notice'), 'retired component rejection'); assert.equal(result.level, 'error');
	}
	assert(!frames.some(frame => frame.type === 'component_updates'));
	assert.equal(readFileSync(join(agent, 'config.yml'), 'utf8'), nativeConfig); assert.equal(hits, 0); assert.equal(readFileSync(counter, 'utf8'), importsBefore);
	const client = { get cwd() { return owner.cwd; }, get conversationId() { return owner.conversationId; }, switchingWorkspace: false, session: { state: { running: false } } };
	const app = express(); app.use(express.json());
	installOmpRoutes(app, () => ({ packages: service, isQuiesced: () => false, get: id => id === owner.clientId ? client : undefined }), req => req.get('Origin') === apiOrigin);
	api = createServer(app); apiOrigin = `http://127.0.0.1:${await listenIsolated(api)}`;
	assert.equal((await post({ action: 'preview', operation: 'update', target: '@oh-my-pi/pi-coding-agent' })).status, 400, 'bundled engine is not an installed plugin');
	assert.equal((await post({ action: 'preview', operation: 'update', target: 'not-installed' })).status, 400);
	assert.equal(hits, 0);
	await execute('install', `${name}@1.0.0`); await execute('disable', name);
	const readCount = hits, factoryCount = readFileSync(counter, 'utf8');
	await post({ action: 'list' }); await post({ action: 'preview', operation: 'update', target: name });
	assert.equal(hits, readCount, 'listing/preview never checks the registry'); assert.equal(readFileSync(counter, 'utf8'), factoryCount);
	latest = '1.1.0'; await execute('update', name);
	let item = (await post({ action: 'list' })).items.find(item => item.name === name);
	assert.equal(item.version, '1.1.0'); assert.equal(item.enabled, false, 'upgrade keeps disabled state');
	latest = '2.0.0'; const beforeFailure = readFileSync(join(plugins, 'package.json'), 'utf8');
	await execute('update', name, 'failed');
	assert.equal(readFileSync(join(plugins, 'package.json'), 'utf8'), beforeFailure);
	assert.equal((await post({ action: 'list' })).items.find(item => item.name === name).version, '1.1.0', 'native factory failure rolls back installed files');
	if (process.argv.includes('--browser')) {
		const { chromium } = await import('playwright-core'); const { CHROME_PATH } = await import('./lib/chrome.mjs');
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath(), headless: true });
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], sent = []; let starts = 0, browserState;
		page.on('pageerror', error => errors.push(error.message));
		page.on('websocket', ws => { ws.on('framesent', ({ payload }) => sent.push(JSON.parse(String(payload)))); ws.on('framereceived', ({ payload }) => { browserState = mergeSnapshot(browserState, JSON.parse(String(payload))); }); });
		await page.addInitScript(id => sessionStorage.setItem('pi-web-client-id', id), owner.clientId);
		await page.route(/\/api\/omp-packages(?:\?|$)/, async route => {
			const body = route.request().postDataJSON(); assert.equal(body.clientId, owner.clientId); assert.equal(body.conversationId, owner.conversationId);
			if (body.action === 'start') starts++;
			const response = await fetch(`${apiOrigin}/api/omp-packages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: apiOrigin }, body: JSON.stringify(body) });
			const text = await response.text(); wire.push(JSON.parse(text)); await route.fulfill({ status: response.status, contentType: 'application/json', body: text });
		});
		await page.goto(`http://127.0.0.1:${harness.port}`); await wait(() => browserState, 'browser connected');
		const openSettings = async () => { await page.getByRole('button', { name: /^(设置|Settings)$/ }).and(page.locator(':visible')).first().click(); await page.getByText(/^(所有设置|All settings)$/).click(); await page.locator('.settings-rail').getByRole('button', { name: 'Extensions', exact: true }).click(); };
		await openSettings(); assert.equal(await page.locator('.settings-rail').getByRole('button', { name: /组件更新|Component updates/ }).count(), 0);
		const panel = page.locator('.omp-packages-panel'), row = panel.locator('.settings-group > .settings-skill-row').filter({ hasText: name });
		await row.getByText('1.1.0 · 个人设置已停用', { exact: true }).waitFor();
		const uiUpdate = async phase => {
			const count = starts, requestsBefore = hits;
			await row.getByRole('button', { name: /^(更新|Update)$/ }).click(); await panel.locator('.omp-package-plan').waitFor();
			assert.equal(starts, count); assert.equal(hits, requestsBefore, 'review does not fetch or execute the update');
			await panel.getByRole('button', { name: /^(执行此操作|Run this operation)$/ }).click();
			await wait(() => starts === count + 1, 'one user update');
			await wait(() => service.jobs(owner)[0]?.phase === phase, 'native update outcome');
			await panel.locator('.omp-package-jobs > .settings-skill-row').first().getByText(phase === 'success' ? '包操作完成；会话尚未重载' : '操作失败', { exact: true }).waitFor();
			assert.equal(starts, count + 1);
		};
		latest = '1.2.0'; await uiUpdate('success'); await row.getByText('1.2.0 · 个人设置已停用', { exact: true }).waitFor();
		latest = '2.0.0'; await uiUpdate('failed');
		assert.equal((await service.list(root)).items.find(item => item.name === name).version, '1.2.0');
		const startBeforeReload = starts; await page.reload(); await openSettings();
		await panel.locator('.omp-package-jobs > .settings-skill-row').first().getByText('操作失败', { exact: true }).waitFor();
		assert.equal(starts, startBeforeReload, 'reload only restores job status, never retries');
		assert(!sent.some(frame => ['check_component_updates', 'update_component', 'run_command', 'prompt', 'extensions_reload'].includes(frame.type)), 'package UI does not use Pi updates, global npm install, model requests or automatic reload');
		mkdirSync('tests/scratch', { recursive: true });
		for (const width of [1440, 390]) {
			await page.setViewportSize({ width, height: 1000 });
			for (const theme of ['light', 'dark']) {
				await page.evaluate(value => document.documentElement.dataset.appearance = value, theme);
				assert(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'update panel fits viewport');
				await panel.screenshot({ path: `tests/scratch/omp-updates-${theme}-${width}.png`, animations: 'disabled' });
			}
		}
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en')); await page.reload(); await openSettings();
		await panel.locator('.omp-package-jobs > .settings-skill-row').first().getByText('Operation failed', { exact: true }).waitFor();
		assert.deepEqual(errors, []);
	}
	const countBeforeFailure = hits; registryFailure = true; latest = '1.2.0';
	await execute('install', 'missing-registry-package@1.0.0', 'failed');
	assert(hits > countBeforeFailure); registryFailure = false;
	const final = await post({ action: 'list' }); assert.equal(final.items.find(item => item.name === name).version, browser ? '1.2.0' : '1.1.0');
	assert.equal(final.items.find(item => item.name === name).enabled, false);
	assert(!existsSync(join(plugins, 'node_modules/missing-registry-package')));
	assert(!JSON.stringify(wire).includes('UPDATE_FACTORY_PRIVATE')); assert(!JSON.stringify(wire).includes('REGISTRY_PRIVATE'));
	assert(!state.messages.length, 'package operations never write chat history');
	console.log('PASS OMP component replacement: bundled engine identity, retired Pi updates rejected, native private-registry upgrade/rollback, state preserved, unavailable registry failure, no implicit reload or secret output' + (browser ? ', browser review/apply/failure/reload and zh/en narrow themes' : ''));
} finally {
	await browser?.close(); socket?.terminate(); await harness?.stop(); await service?.close();
	api?.closeAllConnections(); if (api) await new Promise(resolve => api.close(resolve)); registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
