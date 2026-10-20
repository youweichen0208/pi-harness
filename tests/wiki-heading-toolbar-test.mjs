import { wikiToolbar } from "./lib/wiki-toolbar.mjs";
// #99: selection toolbar heading levels must look different and retain their semantics.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';

const port = 9299;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-heading-toolbar-'));
writeFileSync(join(base, 'note.md'), '# Heading regression\n\nSecond level\n\nThird level\n');
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_PKG_ROOT: process.cwd(), PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	const popup = page.context().waitForEvent('page');
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	page = await popup;
	await page.locator('.setup-modal .modal-close').click().catch(() => {});
	const editor = page.locator('.wiki-prose .fp-rich-document');
	for (const [level, text] of [[2, 'Second level'], [3, 'Third level']]) {
		await editor.locator('p', { hasText: text }).evaluate(el => {
			el.closest('[contenteditable]').focus();
			const range = document.createRange(); range.selectNodeContents(el);
			getSelection().removeAllRanges(); getSelection().addRange(range);
		});
		await wikiToolbar(page, '正文');
		await page.getByRole('menuitem', { name: `标题 ${level}`, exact: true }).click();
		await editor.locator(`h${level}`, { hasText: text }).waitFor();
		await page.keyboard.press('ControlOrMeta+s');
		await page.locator('.wiki-save-status.saved').waitFor();
		assert(readFileSync(join(base, 'note.md'), 'utf8').includes(`${'#'.repeat(level)} ${text}`));
	}
	// The floating toolbar must also let users return a heading to normal text.
	await editor.locator('h3', { hasText: 'Third level' }).evaluate(el => {
		el.closest('[contenteditable]').focus();
		const range = document.createRange(); range.selectNodeContents(el);
		getSelection().removeAllRanges(); getSelection().addRange(range);
	});
	await wikiToolbar(page, '正文');
	await page.getByRole('menuitem', { name: '正文', exact: true }).click();
	await editor.locator('p', { hasText: 'Third level' }).waitFor();
	assert.equal(await editor.locator('h3', { hasText: 'Third level' }).count(), 0);
	await page.keyboard.press('ControlOrMeta+s');
	await page.locator('.wiki-save-status.saved').waitFor();
	const source = readFileSync(join(base, 'note.md'), 'utf8');
	assert(source.includes('\n\nThird level\n') && !source.includes('### Third level'));
	assert(source.includes('## Second level'), 'unselected heading remains unchanged');
	console.log('PASS Wiki formatting: H2/H3 menu choices, heading/paragraph conversion and Markdown persistence');
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
