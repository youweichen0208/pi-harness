// The structure menu marks only the cell it was opened on: no row band, no
// column band, no header cell. Also checks that whatever IS painted lands on
// the right column (the header/body off-by-one class of bug).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9391;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-cell-target-'));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'note.md'), '# Cell\n\n| 列1 | 列2 | 列3 | 列4 |\n| --- | --- | --- | --- |\n| a | b | c | d |\n| e | f | g | h |\n');
writeFileSync(join(base, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(base, 'agent/auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(20000);
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.locator('.setup-modal .modal-close').click({ timeout: 3000 }).catch(() => {});
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	const dialog = page.locator('.wiki-document-dialog[open]');
	await dialog.waitFor();
	const table = dialog.locator('.wiki-prose .fp-rich-document table').first();
	await table.waitFor();

	const painted = () => page.evaluate(() => {
		const t = document.querySelector('.wiki-document-dialog[open] .wiki-prose table');
		const mark = node => [...node.parentElement.children].indexOf(node);
		return {
			cells: [...t.querySelectorAll('[data-cell-target]')].map(c => `${c.parentElement.rowIndex}:${mark(c)}`),
			headers: [...t.querySelectorAll('th[data-column-target]')].map(c => mark(c)),
			rows: [...t.querySelectorAll('tr[data-row-target]')].map(r => r.rowIndex),
			// Every painted background that is not the plain page colour.
			blues: [...t.querySelectorAll('th, td')]
				.filter(c => getComputedStyle(c).backgroundColor === 'rgb(224, 243, 252)')
				.map(c => `${c.parentElement.rowIndex}:${mark(c)}`),
		};
	});

	// Right-click the third data row's last column — a cell that is neither first nor last.
	await table.locator('tbody tr').first().locator('td:not([data-rich-gutter])').nth(2).click({ button: 'right' });
	await page.locator('.fp-table-menu').waitFor();
	await sleep(300);
	const state = await painted();
	console.log('after right-click on content column 3, data row 1:', JSON.stringify(state));

	// Content column 3 of data row 1 = DOM row 1, DOM cell index 3 (0 is the gutter).
	assert.equal(state.cells.length, 1, `exactly one cell is marked (got ${state.cells.length}: ${state.cells})`);
	assert.equal(state.cells[0], '1:3', `the marked cell is the one that was right-clicked (got ${state.cells[0]})`);
	assert.equal(state.headers.length, 0, 'no header cell is painted');
	assert.equal(state.rows.length, 0, 'no row band is painted');
	assert.deepEqual(state.blues, ['1:3'], `only the target cell is blue (got ${JSON.stringify(state.blues)})`);

	// Dismissing clears it.
	await table.locator('tbody tr').first().locator('td:not([data-rich-gutter])').nth(2).click({ button: 'right' });
	await page.locator('.fp-table-menu').waitFor({ state: 'detached' });
	await sleep(200);
	const cleared = await painted();
	assert.deepEqual(cleared, { cells: [], headers: [], rows: [], blues: [] }, `dismissing clears every mark (got ${JSON.stringify(cleared)})`);

	console.log('PASS cell target: the structure menu paints only the cell it was opened on, and dismissing clears it');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
