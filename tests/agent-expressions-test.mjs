/** Real browser: bundled sprite, preference persistence, reduced motion and small layouts. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
const root = mkdtempSync(join(tmpdir(), "pi-expressions-"));
let harness, browser;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_TOKEN: "" } });
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
	const page = await context.newPage(), errors = [];
	page.on("pageerror", error => errors.push(error.message));
	const url = `http://127.0.0.1:${harness.port}`;
	const openSettings = async () => {
		await page.goto(url);
		await page.locator('.setup-modal .modal-close').click();
		await page.locator('.topbar-more .chip').click();
		await page.getByRole('button', { name: '所有设置', exact: true }).click();
		await page.getByRole('button', { name: '外观', exact: true }).click();
	};
	await openSettings();
	const toggle = page.getByRole('switch', { name: '动态表情', exact: true });
	assert.equal(await toggle.getAttribute('aria-checked'), 'true');
	const pet = page.locator('.expression-setting .agent-expression');
	await pet.scrollIntoViewIfNeeded();
	await page.waitForFunction(() => document.querySelector('.expression-setting .agent-expression')?.getAttribute('data-animate') === 'true');
	assert.equal(await pet.evaluate(el => getComputedStyle(el, '::before').animationName), 'agent-expression-eyes');
	const dimensions = await page.evaluate(async () => {
		const img = new Image(); img.src = '/pets/grass-cow/idle.png'; await img.decode(); return [img.naturalWidth, img.naturalHeight];
	});
	assert.deepEqual(dimensions, [235, 215]);
	const frames = [];
	for (let i = 0; i < 5; i++) { frames.push((await pet.screenshot()).toString('base64')); await page.waitForTimeout(220); }
	const delta = await page.evaluate(async frames => {
		const pixels = await Promise.all(frames.map(async frame => {
			const img = new Image(); img.src = 'data:image/png;base64,' + frame; await img.decode();
			const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
			const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); return { width: img.width, height: img.height, bytes: ctx.getImageData(0, 0, img.width, img.height).data };
		}));
		let changed = 0, outsideEyes = 0;
		for (const frame of pixels.slice(1)) for (let i = 0; i < frame.bytes.length; i += 4) {
			if (frame.bytes.slice(i, i + 4).some((v, k) => v !== pixels[0].bytes[i + k])) {
				changed++; const x = (i / 4 % frame.width) / frame.width, y = Math.floor(i / 4 / frame.width) / frame.height;
				if (x < .16 || x > .60 || y < .16 || y > .28) outsideEyes++;
			}
		}
		return { changed, outsideEyes };
	}, frames);
	assert(delta.changed > 0, 'pupils visibly move across animation frames');
	assert.equal(delta.outsideEyes, 0, 'face, caption and background stay pixel-identical');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	assert.equal(await pet.evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
	assert.equal(await pet.evaluate(el => getComputedStyle(el, '::before').animationPlayState), 'paused');
	await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
	await toggle.click();
	assert.equal(await toggle.getAttribute('aria-checked'), 'false');
	assert.equal(await pet.isVisible(), false);
	await openSettings();
	assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'off preference survives reload');
	const sibling = await context.newPage(); await sibling.goto(url);
	await toggle.click();
	await sibling.waitForFunction(() => document.documentElement.dataset.agentExpressions === 'true');
	assert.equal(await toggle.getAttribute('aria-checked'), 'true');
	await page.evaluate(() => { localStorage.setItem('pi-harness:theme', 'graphite'); window.dispatchEvent(new StorageEvent('storage', { key: 'pi-harness:theme' })); });
	mkdirSync('tests/scratch', { recursive: true });
	await page.locator('.appearance-panel').screenshot({ path: 'tests/scratch/agent-expressions-dark.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await toggle.scrollIntoViewIfNeeded();
	assert(await toggle.isVisible());
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	await page.screenshot({ path: 'tests/scratch/agent-expressions-mobile.png' });
	assert.deepEqual(errors, []);
	console.log('PASS agent expressions: sprite, animation, reduced motion, hidden page pause, settings/reload/cross-window sync, dark and mobile');
} finally { await browser?.close(); await harness?.stop(); rmSync(root, { recursive: true, force: true }); }
