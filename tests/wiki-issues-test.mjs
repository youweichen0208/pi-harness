import { wikiToolbar, wikiInsert } from "./lib/wiki-toolbar.mjs";
// #116/#117: detached Wiki chat defaults, live outline, heading caret and table boundaries.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";

const port = 9317;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-issues-'));
writeFileSync(join(base, 'table.md'), '# Table\n\n| A | B |\n| --- | --- |\n| One | Two |\n');
writeFileSync(join(base, 'note.md'), '# Heading regression\n\n## Existing heading\n\nParagraph\n');
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(base, 'agent/auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	const popup = page.context().waitForEvent('page');
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	page = await popup;
	page.setDefaultTimeout(10000);
	const editor = page.locator('.wiki-prose .fp-rich-document');

	await editor.waitFor();
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	const chat = page.locator('.wiki-assistant');
	assert(await page.locator('.wiki-outline-aside').isVisible(), 'Wiki outline is visible by default');
	assert(await page.locator('#wiki-panel-outline').isVisible(), 'outline replaces closed chat by default');
	assert.equal(await page.locator('#wiki-panel-chat').isVisible(), false);
	const saved = async () => { await page.keyboard.press('ControlOrMeta+s'); await page.locator('.wiki-save-status.saved').waitFor(); };
	const caretAtEnd = async locator => locator.evaluate(el => {
		el.closest('[contenteditable]').focus();
		const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
		getSelection().removeAllRanges(); getSelection().addRange(r);
	});
	await caretAtEnd(editor.locator('p').last());
	for (const title of ['First new heading', 'New heading']) {
		await page.keyboard.press('Enter');
		await wikiToolbar(page, '正文'); await page.getByRole('menuitem', {name:'标题 2',exact:true}).click();
		await page.keyboard.type(title);
	}
	assert.deepEqual(await editor.locator('h2').allTextContents(), ['Existing heading', 'First new heading', 'New heading']);
	await page.keyboard.press('Enter'); await page.keyboard.type('/h2'); await page.keyboard.press('Enter'); await page.keyboard.type('Slash heading');
	await page.keyboard.press('Enter'); await page.keyboard.type('## Shortcut heading');
	assert.deepEqual(await editor.locator('h2').allTextContents(), ['Existing heading', 'First new heading', 'New heading', 'Slash heading', 'Shortcut heading']);
	await saved();
	assert(readFileSync(join(base, 'note.md'), 'utf8').includes('## Shortcut heading'));
	// Tabs preserve the existing composer, update from unsaved DOM and never write a TOC into Markdown.
	const input = page.locator('.wiki-agent-host .inputbar textarea');
	await page.locator('.wiki-window-header').getByRole('button', { name: '问 pi', exact: true }).click();
	await page.getByRole('button', { name: '固定到右侧', exact: true }).click();
	await input.fill('Retained draft');
	const panelWidth = (await chat.boundingBox()).width;
	await page.getByRole('button', { name: '收起对话面板', exact: true }).click();
	assert(await page.locator('#wiki-panel-outline').isVisible(), 'closing Ask pi restores outline');
	assert.equal((await page.locator('.wiki-outline-aside').boundingBox()).width, panelWidth);
	await page.locator('.wiki-window-header').getByRole('button', { name: '问 pi', exact: true }).click();
	assert.equal(await input.inputValue(), 'Retained draft');
	await page.getByRole('button', { name: '收起对话面板', exact: true }).click();
	assert.deepEqual((await page.locator('.wiki-outline-link').allTextContents()).slice(1), await editor.locator('h2').allTextContents());
	await caretAtEnd(editor.locator('h2').last()); await page.keyboard.type(' updated');
	await page.locator('.wiki-outline button', { hasText: 'Shortcut heading updated' }).waitFor();
	await page.locator('.wiki-outline button', { hasText: 'Existing heading' }).click();
	await page.waitForFunction(() => {
		const heading = document.querySelector('.wiki-prose h2').getBoundingClientRect();
		const viewport = document.querySelector('.wiki-document').getBoundingClientRect();
		return heading.top >= viewport.top && heading.bottom <= viewport.bottom;
	});
	await page.locator('.wiki-ask-toggle').click();
	assert.equal(await input.inputValue(), 'Retained draft');
	await page.getByRole('button', { name: '收起对话面板', exact: true }).click();
	assert(await page.locator('#wiki-panel-outline').isVisible());
	// File references must switch from the outline back to the composer.
	await page.locator('.wiki-tree-row[title="table.md"] .file-reference-action').click();
	assert(await chat.isVisible());
	await saved();
	assert(!readFileSync(join(base, 'note.md'), 'utf8').includes('<!-- toc -->'));
	// Table-only document has real landing paragraphs both before and after, even after reopening.
	const originalTable = readFileSync(join(base, 'table.md'), 'utf8');
	await page.locator('.wiki-tree-row[title="table.md"]').click();
	await editor.locator('table').waitFor();
	assert(await chat.isVisible(), 'document navigation preserves panel preference');
	assert.equal(readFileSync(join(base, 'table.md'), 'utf8'), originalTable, 'render-only landing blocks do not write the file');
	await caretAtEnd(editor.locator('td').last());
	await page.keyboard.press('ArrowDown'); await page.keyboard.type('After table');
	assert.equal(await editor.locator('table').innerText(), 'A\tB\nOne\tTwo');
	assert((await editor.locator('p').allTextContents()).includes('After table'), await editor.innerHTML());
	await editor.locator('th').first().click();
	await page.keyboard.press('ArrowUp'); await page.keyboard.type('Before table');
	assert((await editor.locator('p').allTextContents()).includes('Before table'));
	await saved();
	const tableText = readFileSync(join(base, 'table.md'), 'utf8');
	assert(tableText.indexOf('Before table') < tableText.indexOf('| A |'));
	assert(tableText.indexOf('After table') > tableText.indexOf('| One |'));
	await editor.locator('td').first().click();
	await page.getByRole('button', { name: '选中表格', exact: true }).click();
	assert((await page.evaluate(() => getSelection().toString())).includes('Two'));
	await page.keyboard.press('Backspace'); assert.equal(await editor.locator('table').count(), 0);
	await page.keyboard.press('ControlOrMeta+z'); await editor.locator('table').waitFor();
	await saved();
	await page.getByRole('button', { name: '收起对话面板', exact: true }).click();
	await page.reload(); await editor.waitFor();
	assert(await page.locator('#wiki-panel-outline').isVisible(), 'outline persists on reload');
	assert.equal(await page.locator('#wiki-panel-chat').isVisible(), false);
	assert.equal(await editor.locator('td').last().innerText(), 'Two');
	await page.locator('.wiki-window-header').getByRole('button', { name: '目录', exact: true }).click();
	assert.deepEqual(await page.locator('.wiki-outline-link').allTextContents(), ['Table']);
	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	await page.screenshot({ path: '/tmp/pi-wiki-issues-mobile.png' });
	await page.locator('.wiki-agent-header button').click();
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator('.wiki-tree-row[title="note.md"]').click();
	await editor.locator('h2').last().waitFor();
	assert(await page.locator('#wiki-panel-outline').isVisible(), 'navigation keeps the outline visible');
	await page.locator('.wiki-window-header').getByRole('button', { name: '目录', exact: true }).click();
	await page.locator('.wiki-outline button', { hasText: 'Shortcut heading updated' }).waitFor();
	await page.screenshot({ path: '/tmp/pi-wiki-issues-desktop.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('.wiki-outline button', { hasText: 'Existing heading' }).click();
	assert.equal(await chat.isVisible(), false, 'mobile outline navigation reveals the document');
	assert.deepEqual(errors, []);
	console.log('PASS #116/#117: default outline, chat replacement and persistence, toolbar/slash/shorthand H2 caret, live outline, draft retention, table boundary navigation, selection, delete/undo, save/reopen and mobile');

} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
