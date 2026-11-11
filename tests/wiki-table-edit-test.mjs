// Table structure editing: add/remove rows and columns must reach the saved
// Markdown. The regression this guards is real — the entry points were deleted
// once (see docs/adr/0007-table-structure-editing.md) and no test noticed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { openKnowledge } from './lib/open-knowledge.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9365;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-wiki-table-edit-'));
mkdirSync(join(base, 'agent'));
// Hand-written table: two columns and one data row, so every assertion is unambiguous.
writeFileSync(join(base, 'note.md'), '# Table editing\n\n| Name | Note |\n| --- | --- |\n| a | 1 |\n');
writeFileSync(join(base, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(base, 'agent/auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));

/** Columns declared by the GFM delimiter row. */
const columnsOf = markdown => {
	const delimiter = markdown.split('\n').find(line => /^\s*\|.*---/.test(line));
	assert(delimiter, `no table delimiter row in:\n${markdown}`);
	return delimiter.split('|').slice(1, -1).length;
};
const rowsIn = markdown => markdown.split('\n').filter(line => /^\s*\|/.test(line)).length - 2;

let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(15000);
	const open = async () => {
		const popup = page.context().waitForEvent('page');
		await openKnowledge(page, base, 'note.md');
		const wiki = await popup;
		wiki.setDefaultTimeout(15000);
		await wiki.locator('.wiki-prose .fp-rich-document').waitFor();
		return wiki;
	};
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	page = await open();
	const editor = page.locator('.wiki-prose .fp-rich-document');
	const table = editor.locator('table').first();
	await table.waitFor();

	const save = async () => { await page.keyboard.press('ControlOrMeta+s'); await page.locator('.wiki-save-status.saved').waitFor(); };
	const menu = page.locator('.fp-table-menu');
	/** Right-click a content cell, then pick a structural action. */
	const act = async label => {
		await table.locator('tbody td:not([data-rich-gutter])').first().click({ button: 'right' });
		await menu.waitFor();
		await menu.getByRole('menuitem', { name: label }).click();
		await menu.waitFor({ state: 'detached' });
	};

	// The gutter is editor chrome: present, not editable, absent from the header.
	assert.equal(await table.locator('tbody td[data-rich-gutter][contenteditable="false"]').count(), 1, 'each data row carries one row gutter');
	assert.equal(await table.locator('thead td[data-rich-gutter]').count(), 0, 'header rows carry no gutter');
	assert.equal(await table.locator('th').count(), 2, 'header keeps its two editable cells');

	// Add a column on the right.
	await act('右侧加列');
	await save();
	let markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert.equal(columnsOf(markdown), 3, `adding a column must write a three-column delimiter row:\n${markdown}`);
	assert(!markdown.includes('data-rich-gutter'), 'the gutter must never be serialized');
	assert(!markdown.includes('data-row-target'), 'the row highlight must never be serialized');
	assert(!markdown.includes('data-column-target'), 'the column highlight must never be serialized');

	// Add a row below.
	await act('下方加行');
	await save();
	markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert.equal(rowsIn(markdown), 2, `adding a row must write two data rows:\n${markdown}`);

	// Delete the column again.
	await act('删除当前列');
	await save();
	markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert.equal(columnsOf(markdown), 2, `deleting a column must return to two:\n${markdown}`);

	// Delete the row again.
	await act('删除当前行');
	await save();
	markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert.equal(rowsIn(markdown), 1, `deleting a row must leave one data row:\n${markdown}`);

	// The limit is visible rather than a silent no-op.
	await table.locator('tbody td:not([data-rich-gutter])').first().click({ button: 'right' });
	await menu.waitFor();
	const removeRow = menu.getByRole('menuitem', { name: '删除当前行' });
	assert(await removeRow.isDisabled(), 'the last data row cannot be deleted');
	assert.equal(await removeRow.getAttribute('title'), '表格至少保留一行数据', 'the disabled action explains its limit');

	// Everything survives a save and reopen. The Wiki window reloads in place.
	await save();
	await page.reload();
	const reopened = page.locator('.wiki-prose .fp-rich-document table').first();
	await reopened.waitFor();
	assert.equal(await reopened.locator('th').count(), 2, 'reopened table keeps two header cells');
	assert.equal(await reopened.locator('td:not([data-rich-gutter])').count(), 2, 'reopened table keeps two content cells');
	assert.equal(await reopened.locator('td[data-rich-gutter]').count(), 1, 'the gutter is rebuilt on reopen');
	assert.equal(readFileSync(join(base, 'note.md'), 'utf8').includes('data-rich-gutter'), false, 'saved file stays clean');

	console.log('PASS table structure editing: add/remove column and row reach Markdown, gutter never serialized, limit is visible');
} finally {
	await browser?.close();
	server?.kill();
	rmSync(base, { recursive: true, force: true });
}
