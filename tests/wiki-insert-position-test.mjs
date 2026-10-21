import { wikiToolbar, wikiInsert } from "./lib/wiki-toolbar.mjs";
// Real Chromium regression for slash picker anchors after deleting the command text.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";
const port = 8999, base = mkdtempSync(join(tmpdir(), 'wiki-format-editor-'));
writeFileSync(join(base, 'note.md'), '# Code\n\n```java\npublic class Original {}\n```\n\nInsert here.\n');
let server, browser;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	// ADR-0003: the editor lives in the detached Wiki window.
	const popupPromise = page.context().waitForEvent('page');
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	const wiki = await popupPromise;
	wiki.setDefaultTimeout(15000);
	await wiki.locator('.setup-modal .modal-close').click().catch(() => {});
	const editor = wiki.locator('.wiki-prose .fp-rich-document');
	await editor.locator('pre > code').first().waitFor();
	await wiki.waitForFunction(() => [...(CSS.highlights.get('rich-code-keyword') ?? [])].some(range => range.toString() === 'public'));
	const toolbar = wiki.locator('.wiki-insert-toolbar');
	assert.equal(await wiki.locator('.wiki-prose .rich-format-tools').count(), 0);
	await editor.locator('p').last().fill('Insert here.');
	for (const [label, tag] of [['标题 2', 'h2'], ['标题 2', 'h2'], ['标题 3', 'h3'], ['正文', 'p']]) {
		await wikiToolbar(wiki, '正文'); await wiki.getByRole('menuitem', {name:label,exact:true}).click();
		assert.equal(await editor.locator(`${tag}:not([data-rich-tail])`).last().textContent(), 'Insert here.');
	}
	await wikiInsert(wiki, '提及日期');
	assert.ok((await editor.locator('p:not([data-rich-tail])').last().textContent()).includes(new Date().toLocaleDateString('sv-SE')));
	console.log('PASS complete toolbar, explicit headings/paragraph and date insertion');
	for (const [alias, label, kind] of [['dmk', '代码块', 'code'], ['bg', '插入表格', 'table']]) {
		for (const input of ['mouse', 'keyboard']) {
			await editor.locator('p').last().fill('');
			await wiki.keyboard.type(`/${alias}`);
			const trigger = await editor.locator('p:not([data-rich-tail])').last().boundingBox();
			if (input === 'mouse') await wiki.getByRole('option', { name: label, exact: true }).click();
			else await wiki.keyboard.press('Enter');
			const popup = await wiki.locator(`.wiki-${kind}-popover`).boundingBox();
			assert.ok(Math.abs(popup.x - trigger.x) < 20 && popup.y >= trigger.y && popup.y <= trigger.y + trigger.height + 10, `/${alias} (${input}) picker stays at the insertion point: ${JSON.stringify({ trigger, popup })}`);
			await wiki.keyboard.press('Escape');
			console.log(`PASS /${alias} ${input} positioning`);
		}
	}
	await editor.locator('p').last().fill('');
	await wiki.keyboard.type('/dmk');
	await wiki.getByRole('option', { name: '代码块', exact: true }).click();
	await wiki.locator('.wiki-code-popover').getByRole('option', { name: 'python', exact: false }).click();
	await wiki.keyboard.type('print("slash")');
	await wiki.keyboard.press('Meta+s');
	await wiki.locator('.wiki-save-status.saved').waitFor();
	assert.ok(readFileSync(join(base, 'note.md'), 'utf8').includes('```python\nprint("slash")'));
	console.log('PASS slash insertion/save');
	await editor.locator('p').last().click();
	// Insertion from the unified menu retains the document caret.
	await wikiInsert(wiki, '代码块');
	const popup = await wiki.locator('.wiki-code-popover').boundingBox();
	assert(popup.x >= 0 && popup.y >= 0);
	await wiki.locator('.wiki-code-popover').getByRole('option', { name: 'python', exact: false }).click();
	await wiki.keyboard.type('print("anchored")');
	await wiki.keyboard.press('Meta+s');
	await wiki.locator('.wiki-save-status.saved').waitFor();
	assert.ok(readFileSync(join(base, 'note.md'), 'utf8').includes('```python\nprint("anchored")'));
	console.log('PASS toolbar positioning and insertion/save');
	await wiki.screenshot({ path: "/tmp/pi-wiki-toolbar-full.png" });
	await wiki.setViewportSize({ width: 800, height: 900 });
	assert.equal(await wiki.locator('.wiki-assistant').isVisible(), false, 'Wiki chat starts collapsed');
	await wiki.getByRole('button', { name: '问 pi', exact: true }).click();
	await wiki.locator('.wiki-assistant').waitFor({ state: 'visible' });
	await wiki.locator('.wiki-assistant-header').getByRole('button', { name: '收起对话面板', exact: true }).click();
	await wiki.locator('.wiki-assistant').waitFor({ state: 'hidden' });
	await wikiInsert(wiki, '提及日期');
	assert.ok(await wiki.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'toolbar does not widen the page');
	await wikiInsert(wiki, '代码块');
	const narrowPopup = await wiki.locator('.wiki-code-popover').boundingBox();
	assert.ok(narrowPopup.x >= 0 && narrowPopup.x + narrowPopup.width <= 800, 'scrolled toolbar picker remains inside viewport');
	await wiki.keyboard.press('Escape');
	await wiki.screenshot({ path: "/tmp/pi-wiki-toolbar-narrow.png" });
	console.log('PASS narrow toolbar scrolling and popup bounds');

} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
