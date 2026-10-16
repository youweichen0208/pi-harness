// #98: empty-line hints must not leak across lines, typing, or editor focus.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';

const port = 9298;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-placeholder-'));
writeFileSync(join(base, 'note.md'), '# Placeholder regression\n\n| Column |\n| --- |\n| |\n\nFirst paragraph.\n');
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_PKG_ROOT: process.cwd(), PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	const editor = page.locator('.wiki-prose .fp-rich-document');
	await editor.locator('p').last().waitFor();
	await editor.locator('td').first().evaluate(el => {
		el.closest('[contenteditable]').focus();
		const range = document.createRange(); range.selectNodeContents(el); range.collapse(true);
		getSelection().removeAllRanges(); getSelection().addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	});
	assert.equal(await editor.locator('[data-wiki-placeholder]').count(), 0, 'no paragraph hint in an empty table cell');
	await editor.locator('p').last().evaluate(el => {
		el.closest('[contenteditable]').focus();
		const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
		getSelection().removeAllRanges(); getSelection().addRange(range);
	});
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => document.querySelectorAll('[data-wiki-placeholder]').length === 1);
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => document.querySelectorAll('[data-wiki-placeholder]').length === 1);
	await page.keyboard.type('New text');
	await page.waitForFunction(() => !document.querySelector('[data-wiki-placeholder]'));
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => document.querySelectorAll('[data-wiki-placeholder]').length === 1);
	const hint = editor.locator('[data-wiki-placeholder]');
	const style = await hint.evaluate(el => {
		const pseudo = getComputedStyle(el, '::before');
		return { position: getComputedStyle(el).position, left: pseudo.left, whiteSpace: pseudo.whiteSpace, overflow: pseudo.overflow };
	});
	assert.deepEqual(style, { position: 'relative', left: '2px', whiteSpace: 'nowrap', overflow: 'hidden' });
	await page.keyboard.press('Space');
	await page.waitForFunction(() => !document.querySelector('[data-wiki-placeholder]'));
	await page.keyboard.press('Backspace');
	await hint.waitFor();
	await editor.dispatchEvent('compositionstart', { data: '' });
	assert.equal(await hint.count(), 0, 'IME composition hides the hint before text arrives');
	await editor.dispatchEvent('compositionend', { data: '' });
	await hint.waitFor();
	// Blurring contenteditable can retain the DOM selection: the hint must still disappear.
	await editor.evaluate(el => el.blur());
	await page.waitForFunction(() => !document.querySelector('[data-wiki-placeholder]'), null, { timeout: 2000 });
	await editor.focus();
	await hint.waitFor();
	await page.keyboard.type('Saved paragraph');
	await page.keyboard.press('ControlOrMeta+s');
	await page.locator('.wiki-save-status.saved').waitFor();
	const source = readFileSync(join(base, 'note.md'), 'utf8');
	assert(source.includes('Saved paragraph'));
	assert(!source.includes('输入 /') && !source.includes('data-wiki-placeholder'));
	console.log('PASS Wiki empty-line hint: Enter, typing, spaces, IME, blur/refocus, anchored layout, clean save');
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
