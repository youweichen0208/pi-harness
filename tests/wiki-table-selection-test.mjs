import { openKnowledge } from "./lib/open-knowledge.mjs";
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
import { testEnv } from "./lib/test-env.mjs";

const port = 9348;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-heading-toolbar-'));
writeFileSync(join(base, 'note.md'), '# Table selection\n\nBefore table\n\n| File | Purpose |\n| --- | --- |\n| [`architecture.md`](architecture.md) | Architecture purpose |\n| [`TASKS.md`](TASKS.md) | Task purpose |\n| `examples/*.json` | Final purpose |\n\nAfter table\n\n```sql\nSELECT * FROM accounts;\nSELECT * FROM scratch_accounts;\n```\n');
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	const popup = page.context().waitForEvent('page');
	await openKnowledge(page, base, 'note.md');
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
	const tableBounds = await editor.locator('table').boundingBox();
	await page.mouse.click(tableBounds.x + 1, tableBounds.y + tableBounds.height / 2);
	const viaButton = await page.evaluate(() => getSelection().toString());
	assert(viaButton.includes('File') && viaButton.includes('Final purpose') && !viaButton.includes('After table'));
	assert.equal(await page.locator('.fp-table-tools').count(), 0);
	await page.waitForFunction(() => document.querySelector('table[data-table-selected]'));
	assert(await editor.locator('table').evaluate(table => getComputedStyle(table.querySelector('th')).backgroundColor === getComputedStyle(table.querySelector('td')).backgroundColor), 'header and body share selection fill');
	await page.screenshot({ path: 'tests/scratch/wiki-table-selection.png' });
	await editor.locator('pre > code').click();
	await page.keyboard.press('ControlOrMeta+a');
	const selectedCode = await page.evaluate(() => getSelection().toString());
	assert(selectedCode.includes('SELECT * FROM accounts;') && selectedCode.includes('SELECT * FROM scratch_accounts;'));
	assert(!selectedCode.includes('Before table') && !selectedCode.includes('复制'), 'code select-all excludes surrounding prose and controls');
	await page.keyboard.press('ControlOrMeta+c');
	assert.equal((await page.evaluate(() => navigator.clipboard.readText())).trim(), 'SELECT * FROM accounts;\nSELECT * FROM scratch_accounts;');
	await page.keyboard.press('ControlOrMeta+a');
	assert((await page.evaluate(() => getSelection().toString())).includes('Before table'), 'second code select-all selects document');
	const codeBounds = await editor.locator('pre').boundingBox();
	await page.mouse.click(codeBounds.x + 1, codeBounds.y + codeBounds.height / 2);
	assert.equal(await page.locator('[data-code-select], .fp-table-select-handle').count(), 0);
	assert.equal((await page.evaluate(() => getSelection().toString())).trim(), 'SELECT * FROM accounts;\nSELECT * FROM scratch_accounts;', 'code border selects only code');
	for (const block of [editor.locator('table'), editor.locator('pre')]) {
		const r = await block.boundingBox();
		for (const [x, y] of [[r.x + 1, r.y + r.height / 2], [r.x + r.width - 1, r.y + r.height / 2], [r.x + r.width / 2, r.y + 1], [r.x + r.width / 2, r.y + r.height - 1]]) {
			await page.mouse.click(x, y);
			const text = await page.evaluate(() => getSelection().toString());
			assert(text.includes('Final purpose') || text.includes('SELECT * FROM scratch_accounts;'), 'each outer edge selects its entire block');
			assert(!text.includes('Before table') && !text.includes('After table'));
		}
	}
	await editor.locator('td').last().click();
	assert(await page.evaluate(() => getSelection().isCollapsed), 'cell content click still places the caret');
	await editor.locator('pre > code').click();
	assert(await page.evaluate(() => getSelection().isCollapsed), 'code content click still places the caret');
	assert.equal(readFileSync(join(base, 'note.md'), 'utf8').includes('SELECT * FROM scratch_accounts;'), true, 'selection preserves source');

	console.log('PASS linked table drag, scoped select-all, whole document select-all, toolbar and copy');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	if (server && server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
	rmSync(base, { recursive: true, force: true });
}
