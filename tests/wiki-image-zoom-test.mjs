// Wiki document images open a full-screen zoom viewer, and wide screens keep the document and outline together. No model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";

const port = 9353;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-image-zoom-'));
const original = '# 构建日志排查\n\n下面是昨晚的构建日志截图。\n\n![构建日志](shot.png)\n\n## 结论\n\n日志文字很小，需要放大查看。\n';
writeFileSync(join(base, 'doc.md'), original);
copyFileSync(join(import.meta.dirname, '../build/icon.png'), join(base, 'shot.png'));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(base, 'agent/auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	const popup = page.context().waitForEvent('page');
	await page.locator('.file-name', { hasText: 'doc.md' }).click();
	page = await popup;
	page.setDefaultTimeout(10000);
	page.on('pageerror', error => errors.push(error.message));
	const editor = page.locator('.wiki-prose .fp-rich-document');
	await editor.waitFor();

	// 1. Clicking a document image opens the zoom viewer at fit-to-window size.
	const inline = editor.locator('img');
	await inline.waitFor();
	assert.equal(await inline.evaluate(el => getComputedStyle(el).cursor), 'zoom-in');
	await inline.click();
	const overlay = page.locator('.wiki-image-zoom');
	await overlay.waitFor();
	const zoomed = overlay.locator('.wiki-image-zoom-frame img');
	await page.waitForFunction(() => document.querySelector('.wiki-image-zoom-frame img').style.width !== '');
	const fit = await zoomed.evaluate(el => el.getBoundingClientRect().width);
	assert(fit > 400, `fit width ${fit}`);
	assert.equal(await zoomed.evaluate(el => el.getAttribute('src')?.includes('/api/file')), true);

	// 2. Zoom-in grows the image; the percentage button resets to fit.
	const tools = overlay.locator('.wiki-image-zoom-tools button');
	await tools.nth(2).click();
	const grown = await zoomed.evaluate(el => el.getBoundingClientRect().width);
	assert(grown > fit * 1.2, `zoom-in ${fit} -> ${grown}`);
	await tools.nth(1).click();
	const reset = await zoomed.evaluate(el => el.getBoundingClientRect().width);
	assert(Math.abs(reset - fit) < 2, `reset ${reset} != fit ${fit}`);

	// 3. Escape closes the viewer.
	await page.keyboard.press('Escape');
	await overlay.waitFor({ state: 'detached' });

	// 4. Clicking an image never modifies the document bytes.
	await page.waitForTimeout(1200);
	assert.equal(readFileSync(join(base, 'doc.md'), 'utf8'), original);

	// 5. Wide screens keep the document and outline next to each other, and the
	// document fills the available width instead of leaving an unused right column.
	await page.setViewportSize({ width: 2560, height: 1000 });
	await page.locator('.wiki-outline-aside').waitFor();
	await page.waitForTimeout(300);
	const boxes = await page.evaluate(() => {
		const doc = document.querySelector('.wiki-reading-layout > .wiki-document').getBoundingClientRect();
		const aside = document.querySelector('.wiki-outline-aside').getBoundingClientRect();
		const layout = document.querySelector('.wiki-reading-layout').getBoundingClientRect();
		return { doc: { left: doc.left, right: doc.right }, aside: { left: aside.left }, layout: { left: layout.left, right: layout.right } };
	});
	const gap = boxes.aside.left - boxes.doc.right;
	assert(gap >= 0 && gap < 200, `document/outline gap ${gap}`);
	const leftSlack = boxes.doc.left - boxes.layout.left, rightSlack = boxes.layout.right - boxes.aside.left - 240;
	assert(leftSlack <= 260, `left gutter not capped: ${JSON.stringify(boxes)}`);
	assert(rightSlack <= 32, `wide reading pane must not leave an unused column: ${JSON.stringify(boxes)}`);

	assert.deepEqual(errors, []);
} finally {
	if (browser) await browser.close();
	if (server) server.kill();
	rmSync(base, { recursive: true, force: true });
}
