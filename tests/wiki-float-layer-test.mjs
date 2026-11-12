// Floating surfaces inside the document modal must live IN the modal.
// `.wiki-document-dialog` is a native <dialog showModal()> element: its
// ::backdrop paints in the browser's top layer. A portal target of
// document.body stays in the normal layer, so the overlay is dimmed by the
// backdrop and never receives pointer events — the table structure menu was
// the only wiki overlay hard-coded to body, which read as "the menu opens
// behind everything" (see docs/adr/0007-table-structure-editing.md).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9385;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-float-layer-'));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'note.md'), '# Layer\n\n| Name | Note |\n| --- | --- |\n| a | 1 |\n');
writeFileSync(join(base, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(base, 'agent/auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Where a floating node sits, and who receives a click on it. */
const surface = (page, selector) => page.evaluate((sel) => {
	const node = document.querySelector(sel);
	if (!node) return { present: false };
	const dialog = document.querySelector('.wiki-document-dialog');
	const rect = node.getBoundingClientRect();
	// Sample a point that is certainly inside the floating box and on no child control.
	const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height - 12);
	return {
		present: true,
		insideDialog: !!dialog?.contains(node),
		parentTag: node.parentElement?.tagName ?? null,
		receivesClick: !!hit?.closest(sel),
		hitTag: hit?.tagName ?? null,
	};
}, selector);

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

	// The single-document dialog: a real modal <dialog>, so the top layer matters.
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	const dialog = page.locator('.wiki-document-dialog[open]');
	await dialog.waitFor();
	assert.equal(await page.evaluate(() => document.querySelector('.wiki-document-dialog')?.matches(':modal') ?? false), true, 'the document surface is a modal dialog in the top layer');

	const editor = dialog.locator('.wiki-prose .fp-rich-document');
	await editor.waitFor();
	const table = editor.locator('table').first();
	await table.waitFor();

	// The table structure menu must live inside the dialog and receive its own clicks.
	await table.locator('tbody td:not([data-rich-gutter])').first().click({ button: 'right' });
	await page.locator('.fp-table-menu').waitFor();
	const menu = await surface(page, '.fp-table-menu');
	assert.equal(menu.insideDialog, true, `the table menu portals into the modal dialog, not document.body (parent: ${menu.parentTag})`);
	assert.equal(menu.receivesClick, true, `the table menu receives pointer events (hit ${menu.hitTag})`);

	// And it actually works: a structural action applies and the file changes.
	await page.locator('.fp-table-menu').getByRole('menuitem', { name: /^向右插入/ }).click();
	await page.locator('.fp-table-menu').waitFor({ state: 'detached' });
	await page.keyboard.press('ControlOrMeta+s');
	await page.waitForFunction(() => document.querySelector('.wiki-document-dialog[open]')?.textContent?.includes('已保存') ?? false);
	const saved = (await import('node:fs')).readFileSync(join(base, 'note.md'), 'utf8');
	const columns = saved.split('\n').find(line => /^\s*\|.*---/.test(line)).split('|').slice(1, -1).length;
	assert.equal(columns, 3, `the menu action reaches the file:\n${saved}`);

	console.log('PASS floating layer: the table menu portals into the modal <dialog> and receives clicks there');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
