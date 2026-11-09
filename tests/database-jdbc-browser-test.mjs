/** Local HTTP fixtures only: no database or model calls. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';
const port = 9299, root = mkdtempSync(join(tmpdir(), 'pi-jdbc-browser-'));
let server, browser, runs = 0, tested = false, failRun = false;
const previews = [];
const connection = () => ({ id: 'fixture', version: '1', name: 'Gauss fixture', driver: 'gaussdb', host: 'localhost', port: 5432, user: 'reader', db_name: 'fixture', hasPassword: true, needsTest: !tested, source: { path: '/fixture/dataSources.xml', id: 'a', kind: 'datagrip' }, jdbc: { configDir: '/fixture/DataGrip2026.1', driverId: 'gauss', driverClass: 'fixture.GaussDriver', jarNames: ['gauss driver.jar'], fingerprint: 'fixture' } });
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: testEnv({ PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }), stdio: 'ignore' });
	for (let i = 0; i < 150 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(12000);
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	await page.routeWebSocket('**/ws', route => {
		const upstream = route.connectToServer();
		route.onMessage(message => upstream.send(message));
		upstream.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type === 'snapshot' || message.type === 'snapshot_delta') message.state.piConfigured = true;
			route.send(JSON.stringify(message));
		});
	});
	await page.route('**/api/database', async route => {
		const body = route.request().postDataJSON();
		if (body.action === 'run') { runs++; if (failRun) { failRun = false; return route.fulfill({ status: 400, json: { error: 'JDBC_CONNECTION_FAILED' } }); } }
		if (body.action === 'test') tested = true;
		if (body.action === 'preview') previews.push(body);
		await route.fulfill({ json: { requestId: body.requestId, connections: [connection(), { ...connection(), id: "other", name: "Other untested", needsTest: true }], grants: [], jdbcRuntime: 'detected',
			...(body.action === 'jdbc_drivers' ? { jdbcDrivers: [{ id: 'gauss', name: 'GaussDB', driverClass: 'fixture.GaussDriver', configDir: '/fixture/DataGrip2026.1' }] } : {}),
			...(body.action === 'preview' ? { preview: { ticket: 'ticket', source: body.path, items: [{ key: 'a', sourceId: 'a', connection: connection(), hasPassword: true, change: 'updated', ...(body.jdbcSelection?.driverId || body.jdbcSelection?.jarPaths ? {} : { issue: 'JDBC_DRIVER_AMBIGUOUS' }) }] } } : {}),
			...(body.action === 'run' ? { grid: { columns: ['database'], rows: [['fixture']], elapsedMs: 0, truncated: false } } : {}),
		} });
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.getByRole('button', { name: '数据库', exact: true }).click();
	await page.locator('.database-tree-row', { hasText: 'Gauss fixture' }).click();
	await page.getByText('fixture.GaussDriver · gauss driver.jar', { exact: true }).waitFor();
	assert.equal(runs, 0, 'untested connections must not automatically query');
	await page.getByRole('button', { name: '测试连接', exact: true }).click();
	await page.getByRole('button', { name: '连接成功', exact: true }).waitFor();
	await page.locator('.database-tree-row', { hasText: 'Gauss fixture' }).click();
	await page.locator('.database-indent .database-tree-row').waitFor(); assert.equal(runs, 1);
	failRun = true;
	await page.locator('.database-tree-row', { hasText: 'Gauss fixture' }).click();
	await page.locator('.database-main > [role=alert]').waitFor();
	await page.locator('.database-tree-row', { hasText: 'Other untested' }).click();
	assert.equal(await page.locator('.database-main > [role=alert]').count(), 0, 'a failed connection must not leave its error on another connection');
	await page.getByRole('button', { name: '导入连接', exact: true }).click();
	await page.getByLabel('配置来源', { exact: true }).selectOption('datagrip');
	await page.getByLabel('服务端配置文件路径', { exact: true }).fill('/fixture/dataSources.xml');
	await page.getByText('GaussDB JDBC 驱动映射', { exact: true }).click();
	await page.getByRole('button', { name: '查找本地驱动', exact: true }).click();
	await page.getByLabel('DataGrip 驱动', { exact: true }).selectOption(JSON.stringify(['/fixture/DataGrip2026.1', 'gauss']));
	await page.getByRole('button', { name: '预览同步', exact: true }).click();
	await page.locator('.database-import-list').waitFor();
	assert.equal(previews[0].jdbcSelection.driverId, undefined, 'first preview must work before target selection');
	await page.getByText('找到多个对应驱动，请选择实际使用的 DataGrip 配置目录', { exact: true }).waitFor();
	await page.getByLabel('应用驱动的连接', { exact: true }).selectOption('a');
	await page.getByRole('button', { name: '预览同步', exact: true }).click();
	await page.locator('.database-import-list input:checked').waitFor();
	assert.equal(previews.at(-1).jdbcSelection.sourceId, 'a'); assert.equal(previews.at(-1).jdbcSelection.driverId, 'gauss');
	await page.getByLabel('手动指定本地驱动文件', { exact: true }).check();
	await page.getByLabel('JDBC Driver 类名', { exact: true }).fill('fixture.GaussDriver');
	await page.getByLabel('本地 jar 完整路径（每行一个）', { exact: true }).fill('D:\\drivers\\高斯 driver.jar\nD:\\drivers\\dependency.jar');
	await page.getByRole('button', { name: '预览同步', exact: true }).click();
	await page.locator('.database-import-list input:checked').waitFor();
	assert.deepEqual(previews.at(-1).jdbcSelection.jarPaths, ['D:\\drivers\\高斯 driver.jar', 'D:\\drivers\\dependency.jar']);
	assert.equal(previews.at(-1).jdbcSelection.driverClass, 'fixture.GaussDriver');
	assert.equal(previews.at(-1).jdbcSelection.driverId, undefined);
	mkdirSync('tests/scratch', { recursive: true });
	await page.locator('.wiki-agent-header button').click();
	await page.screenshot({ path: 'tests/scratch/database-jdbc-light.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByLabel('DataGrip 驱动', { exact: true }).scrollIntoViewIfNeeded();
	assert(await page.locator('.database-main').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mapping must fit the narrow pane');
	await page.screenshot({ path: 'tests/scratch/database-jdbc-narrow.png' });
	await page.evaluate(() => { localStorage.setItem('pi-harness:lang', 'en'); });
	await page.reload();
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.getByRole('button', { name: 'Databases', exact: true }).click();
	await page.locator('.database-tree-row', { hasText: 'Gauss fixture' }).click();
	await page.getByText('Local Java detected; a connection test will verify driver compatibility', { exact: true }).waitFor();
	await page.evaluate(() => { document.documentElement.dataset.theme = 'graphite'; document.documentElement.dataset.appearance = 'dark'; });
	if (await page.locator('.wiki-agent-header button').isVisible()) await page.locator('.wiki-agent-header button').click();
	await page.screenshot({ path: 'tests/scratch/database-jdbc-dark-en.png' });
	assert.deepEqual(errors, []);
	console.log('PASS JDBC UI: test gating, driver discovery, first preview, exact target mapping and localized errors');
} finally {
	await browser?.close();
	if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
	rmSync(root, { recursive: true, force: true });
}
