// Header/body column alignment. Every row carries a leading gutter — header rows
// included, as a `th` — so the browser puts each header label directly above the
// column it names. Without the header gutter, column 1 held both the header's
// first cell and the body's gutter: the gutter was stretched to that cell's width
// and every label sat one column left of its body (ADR 0007, tenth item).
// so column 1 holds BOTH the header's first cell and the body's gutter: the
// gutter is stretched to the header cell's width and every header label sits one
// column to the left of the body it names.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9392;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-align-'));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'note.md'), '# Align\n\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |\n');
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

	const report = await page.evaluate(() => {
		const t = document.querySelector('.wiki-document-dialog[open] .wiki-prose table');
		const x = cell => Math.round(cell.getBoundingClientRect().left);
		const w = cell => Math.round(cell.getBoundingClientRect().width);
		const header = t.rows[0], body = t.rows[1];
		return {
			headerCells: [...header.cells].map(c => ({ text: c.textContent.trim(), x: x(c), w: w(c), tag: c.tagName })),
			bodyCells: [...body.cells].map(c => ({ text: c.textContent.trim(), x: x(c), w: w(c), gutter: c.hasAttribute('data-rich-gutter') })),
			// Does each header label sit above the body column it names?
			aligned: [...header.cells].map((c, i) => ({ header: c.textContent.trim(), above: [...body.cells].find(b => x(b) === x(c))?.textContent?.trim() ?? null })),
		};
	});
	// The report is asserted below; no debug dump.
	// The gutter is a narrow control, not a stretched cell.
	assert.equal(report.headerCells[0].w, 14, `the header gutter keeps its 14px width (got ${report.headerCells[0].w})`);
	assert.equal(report.bodyCells[0].w, 14, `the body gutter keeps its 14px width (got ${report.bodyCells[0].w})`);
	// Every named header sits above the body column it names; only the spacer has no body text.
	const named = report.aligned.filter(row => row.header);
	assert.deepEqual(named.map(row => [row.header, row.above]), [['列1', 'a'], ['列2', 'b'], ['列3', 'c']],
		`each header label is above its own column (got ${JSON.stringify(named)})`);
	assert.equal(report.headerCells.length, report.bodyCells.length, 'header and body rows hold the same number of cells');

	console.log('PASS table column alignment: each header label sits above the column it names, gutters stay 14px');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
