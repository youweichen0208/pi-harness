// Single-document dialog and the knowledge library share one reading canvas:
// DocumentReading supplies the header, meta chips, rich/source switch and body,
// while the dialog passes no `ask` and reopens itself on internal links.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9315;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'document-dialog-'));
const doc = '# 单文件文档\n\n正文段落，应该可以直接编辑。\n\n```js\nconst answer = 42;\n```\n\n见 [target](./target.md) 一节。\n';
const target = '# 目标文档\n\n被双链打开的文件。\n';
writeFileSync(join(base, 'note.md'), doc);
writeFileSync(join(base, 'target.md'), target);
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(base, 'agent/auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));

let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.locator('.setup-modal .modal-close').click({ timeout: 3000 }).catch(() => {});

	// Open the Markdown file through the public file tree, like a user would.
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	const dialog = page.locator('.wiki-document-dialog[open]');
	await dialog.waitFor();
	const article = dialog.locator('.wiki-document');
	const editor = article.locator('.wiki-prose .fp-rich-document');
	await editor.waitFor();

	// Same canvas as the knowledge library: wiki-* classes, DocumentReading header.
	assert.equal(await dialog.locator('.single-document-editor').count(), 1);
	// Same title source as the library: frontmatter title, then the first H1, then the filename.
	assert.equal(await article.locator('.wiki-document-heading h1').textContent(), '单文件文档');
	assert.equal(await article.locator('.wiki-document-meta .wiki-meta-chip').count(), 1, 'the dialog shows the saved time chip only');
	assert.equal(await article.locator('.wiki-properties').count(), 0, 'frontmatter properties stay a Wiki reading feature');
	// A document without any heading keeps the filename, so the dialog never shows a blank title.
	assert.equal(await page.locator('.wiki-document-dialog[open] .fp-file-path').textContent().then(text => text.includes('note.md')), true);
	// Formatting runs through the shared single-line toolbar, not the old compact one.
	// The format toolbar is its own row below the title bar, exactly like the library's
	// document toolbar — not squeezed into the title row where it would collapse to "+".
	const toolbarRow = dialog.locator('.fp-format-bar');
	await toolbarRow.waitFor();
	const rowBox = await toolbarRow.boundingBox();
	assert(rowBox && rowBox.width > 400, `format toolbar row gets the full width: ${JSON.stringify(rowBox)}`);
	assert.equal(await toolbarRow.locator('.wiki-unified-toolbar').count(), 1);
	assert(await dialog.locator('.fp-title-row .wiki-unified-toolbar').count() === 0, 'no toolbar inside the title row');

	// The insert palette stays one screen tall: H1–H3 in the grid, H4–H6 in the toolbar overflow,
	// and no inner scrolling at a 940px-tall window.
	await editor.locator('p').last().evaluate(p => { p.closest('[contenteditable]').focus(); const range = document.createRange(); range.selectNodeContents(p); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
	await page.keyboard.type('/');
	const palette = dialog.locator('.wiki-slash-grid');
	await palette.waitFor();
	await page.waitForTimeout(300);
	assert.deepEqual(await palette.locator('.wiki-heading-icon').allTextContents(), ['H1', 'H2', 'H3']);
	const paletteBox = await palette.boundingBox();
	assert(paletteBox.height < 940 / 2, `palette stays under half the viewport: ${paletteBox.height}px`);
	assert.equal(await palette.locator('.fp-slash-options').evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, 'palette fits without inner scrolling');
	await page.keyboard.press('Escape');
	// H4–H6 remain reachable from the toolbar overflow and still insert their block.
	await toolbarRow.getByRole('button', { name: '更多', exact: true }).click();
	assert.deepEqual(await page.getByRole('menuitem').allTextContents().then(items => items.slice(0, 3)), ['标题 4', '标题 5', '标题 6']);
	await page.getByRole('menuitem', { name: '标题 4', exact: true }).click();
	await page.waitForTimeout(300);
	assert.equal(await editor.locator('h4').count(), 1, 'H4 inserts from the overflow menu');
	assert.equal(await editor.locator('.rich-format-tools').count(), 0, 'the compact toolbar no longer doubles up');
	// No ask-pi: the dialog's chat is the main conversation, which the dialog must not drive.
	assert.equal(await article.locator('.wiki-ask-selection').count(), 0);
	assert.equal(await article.locator('[data-code-ask]').count(), 0);
	// Markdown in the dialog has one editing mode only: no preview/source pair and no source toggle.
	assert.equal(await dialog.locator('.fp-view-switch').count(), 0);
	assert.equal(await dialog.locator('.wiki-source-toggle').count(), 0, 'the source toggle is gone from the dialog');
	assert.equal(await article.evaluate(el => el.classList.contains('is-source')), false);

	// The dialog still edits in place and saves to the same file.
	await editor.locator('p').first().evaluate(p => {
		p.closest('[contenteditable]').focus();
		const range = document.createRange();
		range.selectNodeContents(p);
		range.collapse(false);
		const selection = getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await page.keyboard.type('已编辑。');
	await page.keyboard.press('ControlOrMeta+s');
	await page.waitForFunction(() => document.querySelector('.wiki-document-dialog[open]')?.textContent?.includes('已保存') ?? false);
	assert(readFileSync(join(base, 'note.md'), 'utf8').includes('已编辑。'), 'dialog writes the document');

	// An internal link saves the draft, closes this dialog and reopens it on the target document.
	await dialog.locator('.fp-rich-document a').first().click();
	await page.waitForFunction(() => document.querySelector('.wiki-document-dialog[open] .fp-file-path')?.textContent?.includes('target.md') ?? false, undefined, { timeout: 20000 });
	await page.locator('.wiki-document-dialog[open] .wiki-document-heading h1').waitFor();
	// The reopened document shows its own heading, while the breadcrumb keeps the real path.
	assert.equal(await page.locator('.wiki-document-dialog[open] .wiki-document-heading h1').textContent(), '目标文档');
	assert.equal(await page.locator('.wiki-document-dialog[open] .fp-file-path').textContent().then(t => t.includes('target.md')), true);
	assert.deepEqual(errors, [], 'no page errors');
	console.log('PASS single-document dialog: shared DocumentReading canvas, library title source, one toolbar row, no ask-pi, no source toggle, in-place save and internal-link reopen');
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
}
