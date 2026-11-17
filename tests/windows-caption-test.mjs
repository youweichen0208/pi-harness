import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
const root = mkdtempSync(join(tmpdir(), 'pi-caption-'));
let server, browser;
try {
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') } });
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage();
	await page.addInitScript(() => {
		window.captionActions = [];
		window.electronAPI = { platform: 'win32', windowAction: action => window.captionActions.push(action), onWindowState: callback => { callback({ maximized: false, fullscreen: false }); return () => {}; } };
	});
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.locator('.desktop-window-controls').waitFor();
	await page.locator('.setup-modal .modal-close').click({ timeout: 2000 }).catch(() => {});
	for (const width of [1440, 900, 768]) {
		await page.setViewportSize({ width, height: 900 });
		const box = await page.locator('.desktop-window-controls').boundingBox();
		assert.equal(Math.round(box.x + box.width), width);
		assert.equal(Math.round(box.y), 0);
		assert.equal(Math.round(box.width), 132);
	}
	const buttons = page.locator('.desktop-window-controls button');
	for (let i = 0; i < 3; i++) await buttons.nth(i).click();
	assert.deepEqual(await page.evaluate(() => window.captionActions), ['minimize', 'toggle-maximize', 'close']);
	console.log('PASS Windows caption position, sizes and action order at three viewport widths (mock desktop bridge)');
} finally {
	await browser?.close();
	await server?.stop();
	rmSync(root, { recursive: true, force: true });
}
