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
let server, browser, runs = 0, tested = false, failRun = false, repairs = 0, tests = 0, repaired = false, runtimeMissing = false, sourceImported = false, readFails = false, repairFails = false;
const choices = [];
const sourceConnection = () => ({ ...connection(), id: "source-new", name: "New ambiguous source", source: { path: "/new/dataSources.xml", id: "new", kind: "datagrip" } });
const previews = [];
const native = () => ({ ...connection(), id: "native", name: "PG source", driver: repaired ? "gaussdb" : "postgres", jdbc: repaired ? connection().jdbc : undefined, needsTest: repaired && tests < 2, version: repaired ? "2" : "1" });
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
		if (body.action === 'run' && body.id === 'native' && !repaired) return route.fulfill({ status: 400, json: { error: 'Database authentication protocol is not supported by the PostgreSQL driver; GaussDB/openGauss authentication compatibility is not guaranteed. Use a vendor-supported client.' } });
		if (body.action === 'run') { runs++; if (failRun) { failRun = false; return route.fulfill({ status: 400, json: { error: 'JDBC_CONNECTION_FAILED' } }); } }
		if (body.action === 'import' && body.ticket === 'new-ticket') sourceImported = true;
		if (body.action === 'test') { tested = true; tests++; }
		if (body.action === 'jdbc_configure' && repairFails) return route.fulfill({ status: 400, json: { error: 'JDBC_LIBRARY_UNSUPPORTED' } });
		if (body.action === 'jdbc_configure') { repairs++; choices.push(body); if (body.driverId) repaired = true; }
		if (body.action === 'preview') previews.push(body);
		await route.fulfill({ json: { requestId: body.requestId, connections: [connection(), { ...connection(), id: "other", name: "Other untested", needsTest: true }, native(), ...(sourceImported ? [sourceConnection()] : [])], grants: [], syncIssues: sourceImported ? [] : [{ path: "/new/dataSources.xml", sourceId: "new", issue: "New ambiguous source: JDBC_DRIVER_AMBIGUOUS" }], jdbcRuntime: runtimeMissing ? 'missing' : 'detected',
			...(body.action === 'jdbc_configure' && !body.driverId ? { jdbcDrivers: [{ id: 'gauss', name: 'GaussDB', driverClass: 'fixture.GaussDriver', configDir: '/fixture/DataGrip2026.1' }, { id: 'other', name: 'Other Gauss', driverClass: 'fixture.Other', configDir: '/fixture/DataGrip2024.3' }] } : {}),
			...(body.action === 'jdbc_drivers' ? { jdbcDrivers: [{ id: 'gauss', name: 'GaussDB', driverClass: 'fixture.GaussDriver', configDir: '/fixture/DataGrip2026.1' }] } : {}),
			...(body.action === 'preview' ? { preview: { ticket: 'ticket', source: body.path, items: [{ key: 'a', sourceId: 'a', connection: connection(), hasPassword: true, change: 'updated', ...(body.jdbcSelection?.driverId || body.jdbcSelection?.jarPaths ? {} : { issue: readFails ? 'JDBC_LIBRARY_UNSUPPORTED' : 'JDBC_DRIVER_AMBIGUOUS' }) }] } } : {}),
			...(body.action === 'preview' && body.path === '/new/dataSources.xml' ? { jdbcDrivers: [{ id: 'gauss', name: 'GaussDB', driverClass: 'fixture.GaussDriver', configDir: '/fixture/DataGrip2026.1' }], preview: { ticket: 'new-ticket', source: body.path, items: [{ key: 'new', sourceId: 'new', connection: sourceConnection(), hasPassword: true, change: 'new', ...(body.jdbcSelection.driverId ? {} : { issue: 'JDBC_DRIVER_AMBIGUOUS' }) }] } } : {}),
			...(body.action === 'run' ? { grid: { columns: ['database'], rows: [['fixture']], elapsedMs: 0, truncated: false } } : {}),
		} });
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.getByRole('button', { name: '数据库', exact: true }).click();
	await page.locator('.database-tree-row', { hasText: 'Gauss fixture' }).click();
	await page.getByText('fixture.GaussDriver · gauss driver.jar', { exact: true }).waitFor();
	assert.equal(runs, 0, 'untested connections must not automatically query');
	page.once('dialog', dialog => dialog.dismiss());
	await page.getByRole('button', { name: '测试连接', exact: true }).click();
	assert.equal(tests, 0, 'declining local driver execution must not send a test');
	page.on('dialog', dialog => dialog.accept());
	await page.getByRole('button', { name: '测试连接', exact: true }).click();
	await page.getByRole('button', { name: '连接成功', exact: true }).waitFor();
	await page.locator('.database-tree-row', { hasText: 'Gauss fixture' }).click();
	await page.locator('.database-indent .database-tree-row').waitFor(); assert.equal(runs, 1);
	failRun = true;
	await page.locator('.database-tree-row', { hasText: 'Gauss fixture' }).click();
	await page.locator('.database-main > [role=alert]').waitFor();
	await page.locator('.database-tree-row', { hasText: 'Other untested' }).click();
	assert.equal(await page.locator('.database-main > [role=alert]').count(), 0, 'a failed connection must not leave its error on another connection');
	await page.locator('.database-tree-row', { hasText: 'PG source' }).click();
	await page.locator('.database-main > [role=alert]').waitFor();
	await page.locator('.database-main > [role=alert]').getByRole('button', { name: '自动配置 JDBC 驱动并重试' }).click();
	await page.getByRole('dialog', { name: '找到多个本地驱动，请选择该连接使用的驱动' }).getByRole('button', { name: 'GaussDB · fixture.GaussDriver · /fixture/DataGrip2026.1', exact: true }).click();
	await page.getByRole('button', { name: '连接成功', exact: true }).waitFor();
	assert.equal(repairs, 2); assert.equal(choices[1].driverId, 'gauss');
	assert.equal(await page.locator('.database-main > [role=alert]').count(), 0);
	await page.locator('.database-source-warnings summary').click();
	await page.locator('.database-source-warnings').getByRole('button', { name: '自动配置 JDBC 驱动并重试' }).click();
	await page.getByRole('dialog', { name: '找到多个本地驱动，请选择该连接使用的驱动' }).getByRole('button', { name: 'GaussDB · fixture.GaussDriver · /fixture/DataGrip2026.1', exact: true }).click();
	await page.getByRole('button', { name: '连接成功', exact: true }).waitFor();
	assert(sourceImported, 'repair must import the exact new source');
	await page.locator('.database-source-warnings').waitFor({ state: 'detached' });
	await page.locator('.database-tree-row', { hasText: 'Gauss fixture' }).click();
	await page.getByRole('button', { name: '配置 JDBC 驱动', exact: true }).click();
	assert(await page.getByLabel('本地 jar 完整路径（每行一个）', { exact: true }).isVisible(), 'manual fields are the default configuration entry');
	assert.equal(await page.getByLabel('JDBC Driver 类名', { exact: true }).inputValue(), 'fixture.GaussDriver');
	await page.getByLabel('本地 jar 完整路径（每行一个）', { exact: true }).fill('D:\\drivers\\gsjdbc4.jar');
	readFails = true;
	await page.getByRole('button', { name: '尝试从 DataGrip 读取', exact: true }).click();
	await page.getByText('DataGrip 的驱动库配置无法直接复用，请手动填写本地 jar 路径和 Driver 类名', { exact: true }).waitFor();
	assert.equal(await page.getByLabel('本地 jar 完整路径（每行一个）', { exact: true }).inputValue(), 'D:\\drivers\\gsjdbc4.jar');
	mkdirSync('tests/scratch', { recursive: true });
	await page.screenshot({ path: 'tests/scratch/database-jdbc-manual-entry.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByLabel('本地 jar 完整路径（每行一个）', { exact: true }).scrollIntoViewIfNeeded();
	assert(await page.locator('.database-main').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'manual repair must fit the narrow pane');
	await page.screenshot({ path: 'tests/scratch/database-jdbc-manual-narrow.png' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.getByRole('button', { name: '保存并测试连接', exact: true }).click();
	await page.getByRole('button', { name: '连接成功', exact: true }).waitFor();
	assert.deepEqual(previews.at(-1).jdbcSelection.jarPaths, ['D:\\drivers\\gsjdbc4.jar']);
	readFails = false; repairFails = true;
	await page.getByRole('button', { name: '自动配置 JDBC 驱动并重试', exact: true }).click();
	await page.locator('.database-main > [role=alert]').waitFor();
	assert(await page.getByLabel('本地 jar 完整路径（每行一个）', { exact: true }).isVisible(), 'failed automatic repair opens the manual form');
	repairFails = false;
	const genericPreviewStart = previews.length;
	runtimeMissing = true;
	await page.getByRole('button', { name: '立即同步', exact: true }).click();
	await page.getByRole('button', { name: '导入连接', exact: true }).click();
	await page.getByLabel('配置来源', { exact: true }).selectOption('datagrip');
	await page.getByLabel('服务端配置文件路径', { exact: true }).fill('/fixture/dataSources.xml');
	await page.getByText('未检测到可用 Java，请通过 PI_WEB_JAVA 指定 java 可执行文件后重启服务', { exact: true }).waitFor();
	await page.getByText('GaussDB JDBC 驱动映射', { exact: true }).click();
	await page.getByRole('button', { name: '查找本地驱动', exact: true }).click();
	await page.getByLabel('DataGrip 驱动', { exact: true }).selectOption(JSON.stringify(['/fixture/DataGrip2026.1', 'gauss']));
	await page.getByRole('button', { name: '预览同步', exact: true }).click();
	await page.locator('.database-import-list').waitFor();
	assert.equal(previews[genericPreviewStart].jdbcSelection.driverId, undefined, 'first preview must work before target selection');
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
	runtimeMissing = false;
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
