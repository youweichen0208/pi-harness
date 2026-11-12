// A header cell is the table's first row of text: clicking it takes the caret and
// typing edits the column name. Column selection keeps its own affordance — the
// 6px band along the header's top edge — plus the structure menu. Previously the
// single click selected the column and only a double-click could rename, so a
// click on a column name looked dead (ADR 0007, eleventh item).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9394;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-header-edit-'));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'note.md'), '# Header\n\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| a | b | c |\n');
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
	const header = table.locator('th:not([data-rich-gutter])');

	const caretCell = () => page.evaluate(() => {
		const sel = window.getSelection(), node = sel?.anchorNode;
		const el = node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : node) : null;
		const cell = el?.closest?.('th, td') ?? null;
		return { tag: cell?.tagName ?? null, collapsed: sel?.isCollapsed ?? null, rowIndex: cell?.parentElement?.rowIndex ?? null };
	});

	// A plain press on a column name lands the caret and typing edits it.
	await header.first().click();
	const inside = await caretCell();
	assert.equal(inside.tag, 'TH', `a header press puts the caret in the header cell (got ${inside.tag})`);
	assert.equal(inside.collapsed, true, 'the caret is a plain caret, not a structural selection');
	assert.equal(await page.locator('[data-column-target]').count(), 0, 'a plain header press paints no column band');

	await page.keyboard.type('名称');
	await page.keyboard.press('ControlOrMeta+s');
	await page.waitForFunction(() => document.querySelector('.wiki-document-dialog[open]')?.textContent?.includes('已保存') ?? false);
	let markdown = readFileSync(join(base, 'note.md'), 'utf8');
	assert(markdown.includes('列名称1'), `typing in a header cell edits the column name:\n${markdown}`);

	// The header's top band still selects the whole column.
	const box = await header.nth(1).boundingBox();
	await page.mouse.click(box.x + box.width / 2, box.y + 2);
	await sleep(300);
	assert.equal(await page.locator('[data-column-target]').count(), 2, 'the header top band selects the whole column');
	// And a press inside a body cell clears that structural selection.
	await table.locator('tbody td:not([data-rich-gutter])').first().click();
	await sleep(200);
	assert.equal(await page.locator('[data-column-target]').count(), 0, 'a body press clears the column band');

	// The header keeps its own visual level: a grey ground, and the same size as the
	// body it heads. The editor root also carries `.msg-text`, whose chat table rule
	// (`.msg-text thead th { font-size: 12px }`) used to shrink column names below the
	// body text — an inverted hierarchy nobody chose.
	const style = await page.evaluate(() => {
		const t = document.querySelector('.wiki-document-dialog[open] .wiki-prose table');
		const th = t.rows[0].cells[1], td = t.rows[1].cells[1];
		const a = getComputedStyle(th), b = getComputedStyle(td);
		return { thBg: a.backgroundColor, tdBg: b.backgroundColor, thSize: a.fontSize, tdSize: b.fontSize, thWeight: a.fontWeight, tdWeight: b.fontWeight };
	});
	assert.notEqual(style.thBg, style.tdBg, `the header has its own ground (header ${style.thBg}, body ${style.tdBg})`);
	assert.equal(style.thSize, style.tdSize, `the header is not smaller than the body it heads (${style.thSize} vs ${style.tdSize})`);
	assert(Number(style.thWeight) >= Number(style.tdWeight), 'the header carries at least the body weight');

	console.log('PASS header editing: a header press takes the caret and edits the name, the top band still selects the column, the header keeps its own visual level');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
