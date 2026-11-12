/** Compact native package outcomes and log disclosure in the production settings page. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'pi-update-browser-')), agent = join(root, 'agent'); mkdirSync(agent);
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:9', models: [{ id: 'fixture' }] } } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', cacheWarming: 'off' }));
const job = { id: 'update-fixture', phase: 'partial', log: 'native update detail\nline two', results: [
	{ id: 'a', name: 'updated-package', scope: 'user', status: 'updated', from: '1.0.0', to: '1.1.0' },
	{ id: 'b', name: 'unchanged-package', scope: 'project', status: 'unchanged', from: '2.0.0', to: '2.0.0' },
	{ id: 'c', name: 'offline-package', scope: 'user', status: 'skipped', reason: 'offline' },
	{ id: 'd', name: 'warning-package', scope: 'user', status: 'warning', from: '1.0.0', to: '1.0.0', message: 'Registry metadata is stale; retry shortly.' },
	{ id: 'e', name: 'failed-package', scope: 'user', status: 'error', message: 'Fixture network unavailable' },
] };
let server, browser;
try {
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: agent } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(cwd => { sessionStorage.setItem(`pi-extensions-job:${cwd}`, 'update-fixture'); localStorage.setItem('pi-extensions-autocheck', 'false'); }, root);
	await page.route('**/api/extensions', async route => route.request().postDataJSON().action === 'job' ? route.fulfill({ json: job }) : route.continue());
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.getByRole('button', { name: '设置', exact: true }).first().click();
	await page.getByText('所有设置', { exact: true }).click();
	await page.getByRole('button', { name: 'Extensions', exact: true }).click();
	const card = page.locator('.ext-job');
	await card.getByRole('status').filter({ hasText: '部分包未完成更新' }).waitFor();
	assert.equal(await card.locator('.ext-update-results li').count(), 5);
	assert.equal(await card.locator('pre').count(), 0, 'raw log is collapsed initially');
	assert((await card.innerText()).includes('1.0.0 → 1.1.0'));
	assert((await card.innerText()).includes('当前处于离线模式'));
	const log = card.getByRole('button', { name: '查看完整日志' }); await log.focus(); await page.keyboard.press('Enter');
	assert.equal(await card.locator('pre').textContent(), job.log);
	await card.getByRole('button', { name: '收起日志' }).click();
	assert.equal(await card.locator('pre').count(), 0);
	for (const theme of ['light', 'dark']) for (const width of [375, 1440]) {
		await page.evaluate(theme => document.documentElement.dataset.appearance = theme, theme);
		await page.setViewportSize({ width, height: 1000 });
		assert(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
		await card.screenshot({ path: `/tmp/pi152-extension-results-${theme}-${width}.png` });
	}
	await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en')); await page.reload();
	await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
	await page.getByText('All settings', { exact: true }).click();
	await page.getByRole('button', { name: 'Extensions', exact: true }).click();
	await card.getByRole('status').filter({ hasText: 'Some packages could not be updated' }).waitFor();
	assert((await card.innerText()).includes('Offline mode is enabled'));
	assert.deepEqual(errors, []);
	console.log('PASS package summary states, truthful partial failure, collapsed logs, keyboard, zh/en and 375px themes');
} finally { await browser?.close(); await server?.stop(); rmSync(root, { recursive: true, force: true }); }
