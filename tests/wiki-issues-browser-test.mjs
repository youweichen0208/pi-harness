// #109–112: detached Wiki headings, automatic outline removal and table editing. No model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';

const port = 9312;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-heading-toolbar-'));
writeFileSync(join(base, 'note.md'), '# Heading regression\n\n## Second level\n\n### Third level\n\n| A | B |\n| --- | --- |\n| | |\n\nEnd.\n');
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_PKG_ROOT: process.cwd(), PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const main = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	main.setDefaultTimeout(10000);
	await main.goto(`http://127.0.0.1:${port}`);
	await main.locator('.setup-modal .modal-close').click();
	const popup = main.waitForEvent('popup');
	await main.locator('.file-name', { hasText: 'note.md' }).click();
	const page = await popup; page.setDefaultTimeout(10000);
	const editor = page.locator('.wiki-prose .fp-rich-document');
	await editor.waitFor();
	await page.locator(".setup-modal .modal-close").click();
	const failures = [];
	const check = async (name, run) => { try { await run(); console.log('PASS', name); } catch (e) { failures.push(name + ': ' + e.message); } };
	await check('heading Enter creates body paragraph', async () => {
		await editor.locator('h2').evaluate(el => { el.closest('[contenteditable]').focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
		await page.keyboard.press('Enter'); await page.keyboard.type('Body after heading');
		assert.equal(await editor.locator('p', { hasText: 'Body after heading' }).count(), 1);
	});
	await check('no automatic document outline and preserved type hierarchy', async () => {
		assert.equal(await page.locator('.wiki-toc').count(), 0);
		const size = locator => locator.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
		assert(await size(editor.locator('h2')) > await size(editor.locator('p').first()));
	});
	await check('table click edits empty cell', async () => {
		await editor.locator('td').first().click(); await page.keyboard.type('Editable cell');
		assert.equal(await editor.locator('td').first().innerText(), 'Editable cell');
	});
	await check('table column dividers and default alignment', async () => {
		assert.equal(await editor.locator('td').last().evaluate(el => getComputedStyle(el).textAlign), 'center');
		assert(await editor.locator('td').last().evaluate(el => parseFloat(getComputedStyle(el).borderLeftWidth) > 0));
	});
	await check('delete whole table', async () => {
		await editor.locator('td').first().click();
		await page.getByRole('button', { name: '删除表格', exact: true }).click({ timeout: 1500 });
		assert.equal(await editor.locator('table').count(), 0);
	});
	await check('insert and repeatedly edit a fresh table', async () => {
		await editor.locator('p', { hasText: 'End.' }).click();
		await page.keyboard.press('End'); await page.keyboard.press('Enter');
		await page.locator('.wiki-insert-toolbar').getByRole('button', { name: '插入表格', exact: true }).click();
		await page.keyboard.press('Enter');
		await editor.locator('td').first().click(); await page.keyboard.type('Fresh cell');
		await editor.locator('td').first().click();
		assert.equal(await editor.locator('td').first().innerText(), 'Fresh cell');
		await page.keyboard.press('ControlOrMeta+s'); await page.locator('.wiki-save-status.saved').waitFor();
		const saved = readFileSync(join(base, 'note.md'), 'utf8');
		assert(saved.includes('Fresh cell')); assert(saved.includes('\n\nBody after heading'));
		assert(!saved.includes('<!-- toc -->'), 'reading outline does not alter source');
		await page.reload(); await editor.waitFor();
		await page.locator('.setup-modal .modal-close').click();
		assert.equal(await editor.locator('td').first().innerText(), 'Fresh cell');
		await editor.locator('td').first().click();
		await page.getByRole('button', { name: '删除表格', exact: true }).click();
		await page.keyboard.press('ControlOrMeta+s'); await page.locator('.wiki-save-status.saved').waitFor();
		assert(!readFileSync(join(base, 'note.md'), 'utf8').includes('Fresh cell'));
	});
	await check('heading edits do not add an automatic outline on small screens', async () => {
		await editor.locator('h3').evaluate(el => { el.closest('[contenteditable]').focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
		await page.keyboard.type(' updated');
		await editor.locator('h3', { hasText: 'Third level updated' }).waitFor();
		await page.setViewportSize({ width: 600, height: 800 });
		assert.equal(await page.locator('.wiki-toc').count(), 0);
	});
	assert.deepEqual(failures, []);
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(r => server.once('exit', r)); }
	rmSync(base, { recursive: true, force: true });
}
