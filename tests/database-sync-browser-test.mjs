/** No database connections or model calls: exercise polling against a local HTTP fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';
const port = 9296, root = mkdtempSync(join(tmpdir(), 'pi-db-sync-browser-'));
let server, browser, syncs = 0, version = 1;
const connection = () => ({ id: 'fixture', version: String(version), name: `Discovered ${version}`, driver: 'postgres', host: 'localhost', port: 5432, user: 'reader', db_name: 'fixture', hasPassword: false, source: { path: '/fixture/data-sources.json', id: 'a', kind: 'dbeaver' } });
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: testEnv({ PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }), stdio: 'ignore' });
	for (let i = 0; i < 150 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage(); page.setDefaultTimeout(12000);
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	await page.route('**/api/database', async route => {
		const body = route.request().postDataJSON();
		if (body.action === 'sync') syncs++;
		await route.fulfill({ json: { requestId: body.requestId, connections: [connection()], grants: [], syncIssues: [], ...(body.action === 'run' ? { grid: { columns: ['database'], rows: [['fixture']], elapsedMs: 0, truncated: false } } : {}) } });
	});
	await page.clock.install();
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.getByRole('button', { name: '数据库', exact: true }).click();
	await page.locator('.database-tree-row', { hasText: 'Discovered 1' }).waitFor();
	assert(syncs >= 1);
	await page.locator('.database-tree-row', { hasText: 'Discovered 1' }).click();
	await page.getByRole('button', { name: '连接设置', exact: true }).click();
	await page.locator('.database-form input[type=password]').fill('draft-password');
	version = 2;
	await page.clock.fastForward(15000);
	await page.locator('.database-tree-row', { hasText: 'Discovered 2' }).waitFor();
	assert.equal(await page.locator('.database-form input[type=password]').inputValue(), 'draft-password');
	version = 3;
	await page.getByRole('button', { name: '立即同步', exact: true }).click();
	await page.locator('.database-tree-row', { hasText: 'Discovered 3' }).waitFor();
	await page.locator('.wiki-modal-header > button').last().click();
	await page.locator('.database-workbench').waitFor({ state: 'detached' });
	const stoppedAt = syncs; await page.clock.fastForward(45000); assert.equal(syncs, stoppedAt);
	assert.deepEqual(errors, []);
	console.log('PASS database discovery UI: initial sync, periodic sync, draft retention, manual refresh, close cleanup');
} finally {
	await browser?.close();
	if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
	rmSync(root, { recursive: true, force: true });
}
