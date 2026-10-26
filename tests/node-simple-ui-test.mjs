import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { testEnv } from './lib/test-env.mjs';
import { portUp } from './lib/port-utils.mjs';
const root = mkdtempSync(join(tmpdir(), 'node-simple-')), port = 9471;
let server, browser;
try {
	assert.equal(await portUp(port), false);
	writeFileSync(join(root, 'config'), 'Host demo\n HostName example.invalid\n User tester\n');
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.getByRole('tab', { name: '节点', exact: true }).click();
	const entries = page.locator('.node-entry-options');
	await entries.waitFor();
	assert.equal(await entries.getByRole('button').count(), 2);
	assert.equal(await page.locator('.node-simple-start > details').getAttribute('open'), null);
	await entries.getByRole('button', { name: /SSH/ }).click();
	await page.screenshot({ path: '/tmp/pi-nodes-ssh-form.png' });
	await page.getByRole('dialog').locator('details > summary').click();
	await page.getByRole('dialog').getByRole('button', { name: '导入 SSH config', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.locator('input:not([type=checkbox])').fill(join(root, 'config'));
	await dialog.getByLabel('自动同步配置变化', { exact: true }).uncheck();
	await page.waitForFunction(() => !document.querySelector('.node-import-modal button[type=submit]')?.disabled);
	await dialog.locator('button[type=submit]').click();
	await page.locator('.node-item', { hasText: 'demo' }).waitFor();
	await page.locator('.node-item', { hasText: 'demo' }).getByRole('button').first().click();
	assert.equal(await page.locator('.node-detail > details').getAttribute('open'), null);
	await page.locator('.node-detail > details > summary').click();
	await page.locator('.node-detail dl').waitFor();
	assert(await page.locator('.node-detail-summary').isVisible());
	const search = page.locator('.node-search-field input');
	await search.fill('no-matching-node');
	await page.getByText('没有匹配的节点', { exact: true }).waitFor();
	assert.equal(await page.locator('.node-item').count(), 0);
	await search.fill('');
	await page.locator('.node-item', { hasText: 'demo' }).waitFor();

	await page.getByRole('button', { name: '添加节点', exact: true }).click();
	await entries.getByRole('button', { name: /Xshell/ }).click();
	await page.getByRole('dialog').getByRole('heading', { name: 'Xshell 7 导入' }).waitFor();
	assert.equal(await page.getByRole('dialog').locator('button[type=submit]').count(), 1);
	const sessions = join(root, 'xshell'); mkdirSync(sessions);
	const text = '[CONNECTION]\nHost=example.invalid\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=tester\nMethod=0\n';
	writeFileSync(join(sessions, 'first.xsh'), text);
	writeFileSync(join(sessions, 'second.xsh'), text);
	writeFileSync(join(sessions, 'unsupported.xsh'), text.replace('Protocol=SSH', 'Protocol=TELNET'));
	await page.getByRole('dialog').getByLabel('运行服务的机器上的配置路径').fill(sessions);
	await page.getByText('共 3 个会话 · 已选 3 个', { exact: true }).waitFor();
	assert(await page.locator('.node-preview-list label').filter({ hasText: 'second' }).getByRole('checkbox').isChecked());
	assert(await page.locator('.node-preview-list label').filter({ hasText: 'unsupported' }).getByRole('checkbox').isDisabled());
	await page.screenshot({ path: '/tmp/pi-nodes-xshell-preview.png' });
	await page.getByRole('dialog').getByRole('button', { name: '接入全部节点', exact: true }).click();
	await page.locator('.node-item', { hasText: 'first' }).waitFor();
	assert.equal(await page.locator('.node-item', { hasText: 'second' }).count(), 1);
	await page.getByRole('button', { name: '添加节点', exact: true }).click();
	const beforeExpand = await entries.boundingBox();
	await page.locator('.node-simple-start > details > summary').click();
	await page.locator('.node-simple-start.managing').waitFor();
	const afterExpand = await entries.boundingBox();
	for (const axis of ['x', 'y', 'width', 'height']) assert(Math.abs(beforeExpand[axis] - afterExpand[axis]) < 1, `expanding sources must preserve entry ${axis}`);
	await page.screenshot({ path: '/tmp/pi-nodes-manage.png' });
	await page.locator('.node-simple-start > details > summary').click();

	for (const width of [1440, 375]) {
		await page.setViewportSize({ width, height: 900 });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
		await page.screenshot({ path: `/tmp/pi-nodes-simple-${width}.png` });
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.evaluate(() => document.documentElement.dataset.appearance = 'dark');
	await page.screenshot({ path: '/tmp/pi-nodes-simple-dark.png' });
	console.log('PASS two entry points, SSH config import, Xshell form, collapsed settings and narrow layout');
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(root, { recursive: true, force: true });
}
