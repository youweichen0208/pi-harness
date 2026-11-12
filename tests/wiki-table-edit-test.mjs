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
	/** Right-click a content cell, then pick a structural action (the menu shows counts). */
	const act = async (label, times) => {
		await table.locator('tbody td:not([data-rich-gutter])').first().click({ button: 'right' });
		await menu.waitFor();
		if (times) await menu.locator('.fp-table-count').first().fill(String(times));
		await menu.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click();
		if (!times) await menu.waitFor({ state: 'detached' });
	};

	// The gutter is editor chrome: present, not editable, absent from the header.
	assert.equal(await table.locator('tbody td[data-rich-gutter][contenteditable="false"]').count(), 1, 'each data row carries one row gutter');
	// The header carries a gutter too, as a `th`: without it the header's first cell
	// and the body's gutter shared one visual column, which stretched the gutter and
	// shifted every header label one column left of the body it named.
	assert.equal(await table.locator('thead th[data-rich-gutter][contenteditable="false"]').count(), 1, 'the header carries one alignment gutter');
	assert.equal(await table.locator('th:not([data-rich-gutter])').count(), 2, 'header keeps its two editable cells');

	// Double-clicking a header renames the column: the presses that selected the
	// column canceled the native caret, so the release places it back with the
	// whole name selected and typing replaces it in one gesture.
	await table.locator('th:not([data-rich-gutter])').first().dblclick();
	await page.keyboard.type('Renamed');
	await save();
	const renamed = readFileSync(join(base, 'note.md'), 'utf8');
	assert(renamed.includes('| Renamed |'), `double-click rename must reach the saved header:\n${renamed}`);
	assert(!renamed.includes('| Name |'), `the old column name is replaced, not appended:\n${renamed}`);

	// Add a column on the right. A new column is named the way the template names its
	// columns: a blank header reads as a broken table next to real column names.
	await act('向右插入');
	await save();
	let markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert.equal(columnsOf(markdown), 3, `adding a column must write a three-column delimiter row:\n${markdown}`);
	const headerRow = markdown.split('\n').find(line => /^\s*\|/.test(line)) ?? '';
	assert.equal(headerRow.split('|').slice(1, -1).filter(cell => !cell.trim()).length, 0, `the inserted column carries a name, so no header cell is blank:\n${markdown}`);
	assert(!markdown.includes('data-rich-gutter'), 'the gutter must never be serialized');
	assert(!markdown.includes('data-row-target'), 'the row highlight must never be serialized');
	assert(!markdown.includes('data-column-target'), 'the column highlight must never be serialized');
	assert(!markdown.includes('data-cell-target'), 'the cell mark must never be serialized');

	// Add a row below.
	await act('向下插入');
	await save();
	markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert.equal(rowsIn(markdown), 2, `adding a row must write two data rows:\n${markdown}`);

	// The caret stays in the cell the menu acted on: what is typed next lands in the
	// same place the menu said "当前行 / 当前列" about.
	await page.keyboard.type('typed');
	await save();
	markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert(markdown.includes('typed'), `typing after a structural edit lands in the target cell:\n${markdown}`);
	// Undo the typed text so the assertions below count columns and rows only.
	await table.locator('tbody td:not([data-rich-gutter])').first().click();
	await page.keyboard.press('ControlOrMeta+z');
	await save();
	markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert(!markdown.includes('typed'), `the probe text is removed again:\n${markdown}`);

	// The count field inserts several rows in one action (Yuque's model).
	await act('向下插入', 2);
	await save();
	markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert.equal(rowsIn(markdown), 4, `a count of 2 must add two rows:\n${markdown}`);
	await act('删除所选行');
	await act('删除所选行');
	await save();
	markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert.equal(rowsIn(markdown), 2, `deleting rows again returns to two:\n${markdown}`);

	// Delete the column again.
	await act('删除所选列');
	await save();
	markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert.equal(columnsOf(markdown), 2, `deleting a column must return to two:\n${markdown}`);

	// Delete the row again.
	await act('删除所选行');
	await save();
	markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert.equal(rowsIn(markdown), 1, `deleting a row must leave one data row:\n${markdown}`);

	// The limit is visible rather than a silent no-op.
	await table.locator('tbody td:not([data-rich-gutter])').first().click({ button: 'right' });
	await menu.waitFor();
	const removeRow = menu.getByRole('menuitem', { name: '删除所选行' });
	assert(await removeRow.isDisabled(), 'the last data row cannot be deleted');
	assert.equal(await removeRow.getAttribute('title'), '表格至少保留一行数据', 'the disabled action explains its limit');

	// A second right-click on the same target dismisses the menu instead of re-opening
	// it, and closing always drops the painted targets: a menu that vanishes must not
	// leave an L-shaped highlight the user can no longer act on.
	const target = table.locator('tbody td:not([data-rich-gutter])').first();
	// The menu is already open on this target from the limit check above, so the very
	// next right-click on it is the dismiss.
	assert.equal(await page.locator('[data-cell-target]').count(), 1, 'the open menu marks the cell it acts on');
	assert.equal(await page.locator('table [data-column-target]').count(), 0, 'the menu paints no column band');
	assert.equal(await page.locator('table tr[data-row-target]').count(), 0, 'the menu paints no row band');
	assert(!(await page.locator('table[data-table-selected]').count()), 'the menu does not select the whole table');
	await target.click({ button: 'right' });
	await menu.waitFor({ state: 'detached' });
	assert.equal(await page.locator('[data-cell-target]').count(), 0, 'dismissing the menu clears the cell mark');
	// Re-opening on the same target works normally afterwards.
	await target.click({ button: 'right' });
	await menu.waitFor();
	await target.click({ button: 'right' });
	await menu.waitFor({ state: 'detached' });

	// Escape closes the menu: it lives in a portal the editor's own key handler never sees.
	await page.keyboard.press('Escape');
	await menu.waitFor({ state: 'detached' });

	// Everything survives a save and reopen. The Wiki window reloads in place.
	await save();
	await page.reload();
	const reopened = page.locator('.wiki-prose .fp-rich-document table').first();
	await reopened.waitFor();
	assert.equal(await reopened.locator('th:not([data-rich-gutter])').count(), 2, 'reopened table keeps two header cells');
	assert.equal(await reopened.locator('td:not([data-rich-gutter])').count(), 2, 'reopened table keeps two content cells');
	assert.equal(await reopened.locator('td[data-rich-gutter]').count(), 1, 'the gutter is rebuilt on reopen');
	assert.equal(readFileSync(join(base, 'note.md'), 'utf8').includes('data-rich-gutter'), false, 'saved file stays clean');

	console.log('PASS table structure editing: add/remove column and row reach Markdown, gutter never serialized, limit is visible');
} finally {
	await browser?.close();
	server?.kill();
	rmSync(base, { recursive: true, force: true });
}
