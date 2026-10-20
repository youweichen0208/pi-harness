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

const port = 9347;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-heading-toolbar-'));
writeFileSync(join(base, 'note.md'), '# Quote end\n\n> Last quoted paragraph\n');
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

	const editor = page.locator('.wiki-prose .fp-rich-document');
	await editor.waitFor();
	if (await page.locator(".setup-modal .modal-close").isVisible()) await page.locator(".setup-modal .modal-close").click();
	const original = readFileSync(join(base, 'note.md'), 'utf8');
	const tail = editor.locator(':scope > p[data-rich-tail]');
	await tail.waitFor({ timeout: 1500 });
	await tail.click();
	await page.waitForTimeout(1000);
	assert.equal(readFileSync(join(base, 'note.md'), 'utf8'), original, 'empty caret line must not rewrite the document');
	assert((await tail.boundingBox()).y >= (await editor.locator('blockquote').boundingBox()).y + (await editor.locator('blockquote').boundingBox()).height);
	await page.keyboard.type('After quote');
	await page.waitForFunction(() => document.querySelector('.fp-rich-document > p')?.textContent?.includes('After quote'));
	assert.equal(await editor.locator('blockquote').innerText(), 'Last quoted paragraph');
	await page.keyboard.press('Enter');
	await page.keyboard.type('Next line');
	await page.waitForTimeout(1200);
	const saved = readFileSync(join(base, 'note.md'), 'utf8');
	assert(saved.includes('> Last quoted paragraph'));
	assert(saved.includes('\n\nAfter quote'));
	assert(!saved.includes('> After quote'));
	assert(saved.includes('Next line'));
	assert(!saved.includes('> Next line'));
	await page.reload();
	await editor.waitFor();
	await tail.waitFor();
	console.log('PASS quote end caret, outside paragraph, save and reload');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	if (server && server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
	rmSync(base, { recursive: true, force: true });
}
