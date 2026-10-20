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

const port = 9348;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-heading-toolbar-'));
writeFileSync(join(base, 'note.md'), '# Table selection\n\nBefore table\n\n| File | Purpose |\n| --- | --- |\n| [`architecture.md`](architecture.md) | Architecture purpose |\n| [`TASKS.md`](TASKS.md) | Task purpose |\n| `examples/*.json` | Final purpose |\n\nAfter table\n');
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
	const first = editor.locator('table a').first();
	const last = editor.locator('table tbody tr').last().locator('td').last();
	const start = await first.boundingBox(), end = await last.boundingBox();
	await page.mouse.move(start.x + 2, start.y + start.height / 2);
	await page.mouse.down();
	await page.mouse.move(end.x + end.width - 4, end.y + end.height / 2, { steps: 20 });
	await page.mouse.up();
	const selected = await page.evaluate(() => getSelection().toString());
	assert(selected.includes('architecture.md') && selected.includes('Final purpose'), `whole table drag: ${selected}`);
	await editor.locator('td').last().click();
	await page.keyboard.press('ControlOrMeta+a');
	const selection = await page.evaluate(() => { const range = getSelection().getRangeAt(0); return { text: getSelection().toString(), hasTitle: range.intersectsNode(document.querySelector('.wiki-document-heading')) }; });
	assert(selection.text.includes('File') && selection.text.includes('Final purpose'));
	assert.equal(selection.hasTitle, false);
	assert(!selection.text.includes('Before table') && !selection.text.includes('After table'), 'first select-all must select only the table');
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.keyboard.press('ControlOrMeta+c');
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	assert(copied.includes('File') && copied.includes('Final purpose') && copied.includes('TASKS.md'));
	await page.keyboard.press('ControlOrMeta+a');
	assert((await page.evaluate(() => getSelection().toString())).includes('After table'));
	await editor.locator('td').last().click();
	await page.locator('.fp-table-select-handle').click();
	const viaButton = await page.evaluate(() => getSelection().toString());
	assert(viaButton.includes('File') && viaButton.includes('Final purpose') && !viaButton.includes('After table'));
	assert.equal(await page.locator('.fp-table-tools').count(), 0);
	await page.waitForFunction(() => document.querySelector('table[data-table-selected]'));
	assert(await editor.locator('table').evaluate(table => getComputedStyle(table.querySelector('th')).backgroundColor === getComputedStyle(table.querySelector('td')).backgroundColor), 'header and body share selection fill');
	await page.screenshot({ path: 'tests/scratch/wiki-table-selection.png' });
	console.log('PASS linked table drag, scoped select-all, whole document select-all, toolbar and copy');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	if (server && server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
	rmSync(base, { recursive: true, force: true });
}
