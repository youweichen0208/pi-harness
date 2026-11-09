/** Local metadata fixtures; no business database or model calls. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';
const port = 9302, root = mkdtempSync(join(tmpdir(), 'pi-db-workbench-'));
let server, browser, tested = false, releaseTables, holdTables = false, failTables = false;
const requests = [];
mkdirSync('tests/scratch', { recursive: true });
const connection = (id = 'primary') => ({ id, version: '1', name: id === 'primary' ? 'Analytics' : 'Archive', driver: 'postgres', host: 'localhost', port: 5432, user: 'reader', db_name: 'analytics', hasPassword: true, needsTest: id === 'primary' && !tested });
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: testEnv({ PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }), stdio: 'ignore' });
	for (let i = 0; i < 150 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(12000);
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	await page.routeWebSocket('**/ws', route => {
		const upstream = route.connectToServer(); route.onMessage(message => upstream.send(message));
		upstream.onMessage(wire => { const message = JSON.parse(wire.toString()); if (message.type === 'snapshot' || message.type === 'snapshot_delta') message.state.piConfigured = true; route.send(JSON.stringify(message)); });
	});
	await page.route('**/api/database', async route => {
		const body = route.request().postDataJSON(); requests.push(body);
		if (body.action === 'test') tested = true;
		let grid;
		if (body.action === 'run') {
			grid = { columns: ['id', 'name', 'amount'], rows: [['9007199254740993', 'Example', null]], elapsedMs: 18, truncated: false, sql: body.sql };
			if (body.operation === 'databases') grid = { ...grid, columns: ['name'], rows: [['analytics'], ['reporting']] };
			if (body.operation === 'tables') {
				if (failTables) { failTables = false; return route.fulfill({ status: 400, json: { error: 'SQLSTATE_42P01' } }); }
				if (holdTables && body.id === 'primary') { holdTables = false; await new Promise(resolve => { releaseTables = resolve; }); }
				grid = { ...grid, columns: ['schema', 'name', 'kind'], rows: body.id === 'archive' ? [['archive', 'old_orders', 'BASE TABLE']] : body.database === 'reporting' ? [['reports', 'monthly', 'VIEW']] : [['public', 'orders', 'BASE TABLE'], ['Sales Data', 'Order Items', 'VIEW']] };
			}
			if (body.operation === 'describe') grid = { ...grid, columns: ['kind', 'name', 'definition', 'nullable', 'default_value'], rows: [['column', 'id', 'bigint', 'NO', null], ['index', 'orders_pk', 'PRIMARY KEY (id)', null, null]] };
			if (body.operation === 'query' && body.sql.includes('WHERE FALSE')) grid.rows = [];
		}
		await route.fulfill({ json: { requestId: body.requestId, connections: [connection(), connection('archive')], grants: [], syncIssues: [{ path: '/bad.xml', issue: 'unavailable' }, { path: '/sqlite.xml', issue: 'unsupported', category: 'unsupported-driver' }], grid } }).catch(() => {});
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.getByRole('button', { name: '数据库', exact: true }).click();
	await page.locator('.database-tree-row', { hasText: 'Analytics' }).click();
	assert.equal(requests.filter(r => r.action === 'run').length, 0);
	assert.equal(await page.locator('.database-source-warnings, .database-source-skipped').count(), 0);
	assert.equal(await page.getByRole('button', { name: '删除连接', exact: true }).isVisible(), false);
	await page.getByRole('button', { name: '测试连接', exact: true }).click();
	await page.locator('.database-success').waitFor();
	await page.screenshot({ path: 'tests/scratch/database-workbench-success.png' });
	assert.equal(await page.getByRole('button', { name: '连接成功', exact: true }).count(), 0);
	await page.locator('.database-catalog article').first().waitFor();
	assert.equal(await page.locator('.database-catalog article').count(), 2);
	// Metadata failures stay visible, stop loading, and can be retried in place.
	failTables = true;
	await page.locator('.database-indent > .database-tree-row', { hasText: 'analytics' }).click();
	const catalogError = page.locator('.database-main > [role=alert]');
	await catalogError.getByText('数据库目录加载失败。', { exact: true }).waitFor();
	assert.match(await catalogError.innerText(), /42P01/);
	assert.equal(await page.locator('.database-busy').count(), 0);
	await page.locator('.database-tabs').getByRole('button', { name: '结构', exact: true }).click();
	assert(await catalogError.isVisible(), 'changing tabs must not dismiss catalog failures');
	await catalogError.getByRole('button', { name: '重新加载目录', exact: true }).click();
	await page.locator('.database-catalog article').first().waitFor();
	assert.equal(await catalogError.count(), 0);
	const orders = page.locator('.database-catalog article').filter({ hasText: 'orders' });
	await orders.getByRole('button', { name: '结构', exact: true }).click();
	await page.locator('.database-grid').getByText('orders_pk', { exact: true }).waitFor();
	await page.locator('.database-tabs').getByRole('button', { name: '数据', exact: true }).click();
	await page.locator('.database-grid').getByText('9007199254740993', { exact: true }).waitFor();
	await page.locator('.database-grid input[type=checkbox]').check();
	assert.equal(await page.locator('.database-grid tr.selected').count(), 1);
	await page.screenshot({ path: 'tests/scratch/database-workbench-results.png' });
	await page.locator('.database-tabs').getByRole('button', { name: 'SQL 查询', exact: true }).click();
	const editor = page.locator('.database-sql-editor .cm-content');
	await editor.fill('SELECT * FROM public.or');
	await page.getByRole('option', { name: 'public.orders', exact: true }).waitFor();
	await page.screenshot({ path: 'tests/scratch/database-workbench-completion.png' });
	await editor.press('ArrowDown'); await editor.press('Enter');
	assert.equal(await editor.innerText(), 'SELECT * FROM "public"."orders"');
	await editor.press('ControlOrMeta+Enter');
	await page.locator('.database-grid').getByText('9007199254740993', { exact: true }).waitFor();
	assert.equal(requests.at(-1).sql, 'SELECT * FROM "public"."orders"');
	await editor.fill('SELECT * FROM public.orders WHERE FALSE');
	await page.getByRole('button', { name: '运行 · ⌘/Ctrl Enter', exact: true }).click();
	await page.locator('.database-grid .database-empty').waitFor();
	await page.locator('.database-indent > .database-tree-row', { hasText: 'reporting' }).click();
	await page.locator('.database-busy').waitFor({ state: 'detached' });
	await editor.fill('SELECT * FROM '); await editor.press('Control+Space');
	await page.getByRole('option', { name: 'reports.monthly', exact: true }).waitFor();
	assert.equal(await page.getByRole('option', { name: 'public.orders', exact: true }).count(), 0);
	await editor.press('Escape');
	// A late metadata response from the old connection must not populate the new one.
	holdTables = true;
	await page.locator('.database-indent > .database-tree-row', { hasText: 'analytics' }).click();
	await page.waitForFunction(() => document.querySelector('.database-busy'));
	await page.locator('.database-tree-row', { hasText: 'Archive' }).click();
	await page.locator('.database-busy').waitFor({ state: 'detached' });
	releaseTables?.();
	await editor.fill('SELECT * FROM '); await editor.press('Control+Space');
	await page.getByRole('option', { name: 'archive.old_orders', exact: true }).waitFor();
	assert.equal(await page.getByRole('option', { name: 'public.orders', exact: true }).count(), 0);
	await editor.press('Escape');
	mkdirSync('tests/scratch', { recursive: true });
	await page.locator('.wiki-agent-header button').click();
	await page.screenshot({ path: 'tests/scratch/database-workbench-light.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	assert(await page.locator('.database-main').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
	await page.screenshot({ path: 'tests/scratch/database-workbench-narrow.png' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.evaluate(() => { localStorage.setItem('pi-harness:lang', 'en'); });
	await page.reload(); await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.getByRole('button', { name: 'Databases', exact: true }).click();
	await page.locator('.database-tree-row', { hasText: 'Analytics' }).click();
	await page.locator('.database-catalog article').first().waitFor();
	await page.evaluate(() => { document.documentElement.dataset.theme = 'graphite'; document.documentElement.dataset.appearance = 'dark'; });
	await page.screenshot({ path: 'tests/scratch/database-workbench-dark-en.png' });
	assert.deepEqual(errors, []);
	console.log('PASS database workbench: toast, disclosure, catalog, structure, row selection, keyboard completion, SQL, empty results, database/connection isolation, responsive and bilingual themes');
} finally {
	releaseTables?.();
	await browser?.close();
	if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
	rmSync(root, { recursive: true, force: true });
}
