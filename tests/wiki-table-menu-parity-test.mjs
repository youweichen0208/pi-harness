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

const port = 9401;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-wiki-table-edit-'));
mkdirSync(join(base, 'agent'));
// Hand-written table: two columns and one data row, so every assertion is unambiguous.
writeFileSync(join(base, 'note.md'), '# Table editing\n\n| Name | Note |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n');
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
	if (process.env.TABLE_HOST === 'file') {
		await page.locator('.file-name', {hasText:'note.md'}).click();
		await page.locator('.wiki-document-dialog[open]').waitFor();
	} else page = await open();
	const editor = page.locator('.wiki-prose .fp-rich-document');
	const table = editor.locator('table').first();
	await table.waitFor();

	const save = async () => { await page.keyboard.press('ControlOrMeta+s'); await page.waitForTimeout(1000); };
	const menu = page.locator('.fp-table-menu');
	/** Right-click a content cell, then pick a structural action (the menu shows counts). */
	const act = async (label, times) => {
		await table.locator('tbody td:not([data-rich-gutter])').first().click({ button: 'right' });
		await menu.waitFor();
		if (times) await menu.locator('.fp-table-count').first().fill(String(times));
		await menu.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click();
		if (!times) await menu.waitFor({ state: 'detached' });
	};

	// Inserting to the right of the final column must append, not index past the row.
	await table.locator('tbody tr').first().locator('td:not([data-rich-gutter])').last().click({button:'right'});
	await menu.getByRole('menuitem',{name:/^向右插入/}).click({position:{x:35,y:18}});
	assert.equal(await table.locator('th:not([data-rich-gutter])').count(),3);
	await table.locator('tbody tr').first().locator('td:not([data-rich-gutter])').last().click({button:'right'});
	await menu.getByRole('menuitem',{name:'删除所选列',exact:true}).click();
	await act('插入序号列到最左侧');
	assert.equal(await table.locator('th:not([data-rich-gutter])').first().innerText(), '序号');
	assert.deepEqual(await table.locator('tbody tr').evaluateAll(rows => rows.map(row => row.querySelector('td:not([data-rich-gutter])').textContent)), ['1','2','3']);
	await table.locator('tbody td:not([data-rich-gutter])').first().click({button:'right'});
	mkdirSync('tests/scratch', {recursive:true});
	await menu.screenshot({path:`tests/scratch/table-menu-${process.env.TABLE_HOST ?? 'wiki'}.png`});
	await menu.getByLabel('自动编号起始数据行').fill('2');
	await menu.getByText('行起自动编号', {exact:true}).click();
	assert.deepEqual(await table.locator('tbody tr').evaluateAll(rows => rows.map(row => row.querySelector('td:not([data-rich-gutter])').textContent)), ['1','1','2']);
	// Native text selection across cells defines a rectangular batch target.
	const select = async (r1,c1,r2,c2) => {
		await table.evaluate((table, coords) => {
			const [r1,c1,r2,c2]=coords;
			const first=table.rows[r1].querySelectorAll('th:not([data-rich-gutter]),td:not([data-rich-gutter])')[c1];
			const last=table.rows[r2].querySelectorAll('th:not([data-rich-gutter]),td:not([data-rich-gutter])')[c2];
			table.closest('[contenteditable]').focus();
			const range=document.createRange();range.setStart(first,0);range.setEnd(last,last.childNodes.length);
			getSelection().removeAllRanges();getSelection().addRange(range);
		},[r1,c1,r2,c2]);
		const cell=table.locator('tr').nth(r1).locator('th:not([data-rich-gutter]),td:not([data-rich-gutter])').nth(c1);
		await cell.click({button:'right'});
		await menu.waitFor();
	};
	await select(1,1,2,2);
	await menu.getByRole('menuitem',{name:'清除内容',exact:true}).click();
	assert.equal(await table.locator('tbody tr').first().locator('td:not([data-rich-gutter])').nth(1).textContent(), '');
	assert.equal(await table.locator('tbody tr').nth(2).locator('td:not([data-rich-gutter])').nth(1).innerText(), 'c');
	await page.keyboard.press('ControlOrMeta+z');
	assert.equal(await table.locator('tbody tr').first().locator('td:not([data-rich-gutter])').nth(1).innerText(), 'a');
	await select(1,1,2,2);
	await menu.getByRole('menuitem',{name:'删除所选行',exact:true}).click();
	assert.equal(await table.locator('tbody tr').count(),1);
	await select(0,1,1,2);
	await menu.getByRole('menuitem',{name:'删除所选列',exact:true}).click();
	assert.equal(await table.locator('th:not([data-rich-gutter])').count(),1);
	// Whole-table selection clears every cell, including the header, but keeps the grid.
	await table.evaluate(table => { const range=document.createRange(); range.selectNode(table); getSelection().removeAllRanges();getSelection().addRange(range); });
	await table.locator('tbody td:not([data-rich-gutter])').first().click({button:'right'});
	await menu.getByRole('menuitem',{name:'清除内容',exact:true}).click();
	assert.deepEqual(await table.locator('th:not([data-rich-gutter]),td:not([data-rich-gutter])').allTextContents(), ['', '']);
	await page.keyboard.press('ControlOrMeta+z');
	await save(); await page.reload();
	if (process.env.TABLE_HOST === 'file') await page.locator('.file-name', {hasText:'note.md'}).click();
	await table.waitFor();
	assert.equal(await table.locator('tbody tr').count(),1);
	assert.equal(await table.locator('th:not([data-rich-gutter])').count(),1);
	assert(!readFileSync(join(base,'note.md'),'utf8').includes('data-cell-target'));
	console.log('PASS numbering, sequence column, batch clear, undo, batch row/column deletion and reopen');
} finally {
	await browser?.close();
	server?.kill();
	rmSync(base, { recursive: true, force: true });
}
