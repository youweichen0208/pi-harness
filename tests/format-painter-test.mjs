import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { testEnv } from "./lib/test-env.mjs";

// Format painter in the Notes editor: both hosts share RichMarkdownEditor, so the
// behaviour proven here is the behaviour Wiki gets. The rules under test are the
// documented rules: replacement, multi-block type copying and plain-text reset.
const root = mkdtempSync(join(tmpdir(), 'format-painter-'));
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r)); assert(port >= 8900);
const base = `http://127.0.0.1:${port}`, token = 'format-painter-test';
let server, browser;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (path, method = 'GET', body) => fetch(`${base}${path}?token=${token}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); } throw Error('Condition timeout'); }
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: token, PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	await until(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } });

	const note = (await (await api('/api/notes', 'POST', { title: 'Painter', body: '## Source heading\n\nPlain target one\n\nPlain target two\n', pinned: false })).json()).note;
	const read = async () => (await (await api(`/api/notes/${note.id}`)).json()).note;

	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	await page.goto(`${base}/?token=${token}`); await page.locator('.setup-modal .modal-close').click();
	await page.getByRole('button', { name: '小记', exact: true }).click(); await page.locator('.note-list-item').first().click();
	const editor = page.locator('.notes-editor .fp-rich-document');
	await editor.waitFor();
	const tools = page.locator('.rich-format-tools');
	await tools.getByRole('button', { name: '更多', exact: true }).click();

	async function caret(selector) {
		await editor.locator(selector).first().evaluate(el => { el.closest('[contenteditable]').focus(); const range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range); });
		await sleep(80);
	}
	async function collapse(selector) {
		await editor.locator(selector).first().evaluate(el => { el.closest('[contenteditable]').focus(); const range = document.createRange(); range.selectNodeContents(el); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range); });
		await sleep(80);
	}

	// Align the source heading so the sample carries a block declaration.
	await collapse('h2'); await page.getByLabel('对齐', { exact: true }).selectOption('center');
	await until(async () => (await read()).body.includes('text-align: center'));

	// Sampling from a heading arms the painter; it stays pressed until applied.
	await collapse('h2');
	const painter = tools.getByRole('button', { name: '格式刷', exact: true });
	assert.equal(await painter.isDisabled(), false);
	await painter.click();
	assert.equal(await painter.getAttribute('aria-pressed'), 'true');

	// Painting a paragraph replaces its block format and never promotes it: the tag
	// only travels when the selection sits in exactly one block, and a single block
	// promotion is an upgrade, so `p` stays `p` here only because the sample says `h2`…
	await caret('p');
	await page.keyboard.press('Escape');
	assert.equal(await painter.getAttribute('aria-pressed'), 'false', 'Escape disarms the painter');

	// Re-arm and paint one paragraph. The painter applies on the editor's own mouseup,
	// so the click has to land inside the document, not on the page chrome.
	await collapse('h2'); await painter.click();
	const target = editor.locator('p').first();
	await collapse('p');
	const box = await target.boundingBox();
	await page.mouse.click(box.x + 4, box.y + box.height / 2);
	await until(async () => /Plain target one<\/h2>/.test((await read()).body));
	assert.equal(await editor.locator('.rich-block > h2').count(), 2, 'single block upgrade produced a second heading');
	assert.equal(await editor.locator('.rich-block > p').count(), 1, 'the untouched paragraph kept its tag');

	// Replace, not merge: the new heading inherits alignment, the source keeps its own.
	const saved = (await read()).body;
	assert.equal((saved.match(/text-align: center/g) ?? []).length, 2, 'block formatting was copied, not merged');

	// Multi-block selection copies both styles and heading type.
	// The range is set and painted without a click, because any click would collapse it.
	const headingsBefore = await editor.locator('.rich-block > h2').count();
	const paragraphsBefore = await editor.locator('.rich-block > p').count();
	await collapse('h2'); await painter.click();
	await editor.evaluate(root => {
		const blocks = [...root.querySelectorAll(':scope > .rich-block')].map(wrapper => wrapper.firstElementChild).filter(Boolean);
		const range = document.createRange();
		range.setStart(blocks[0], 0);
		range.setEnd(blocks[blocks.length - 1], blocks[blocks.length - 1].childNodes.length);
		getSelection().removeAllRanges(); getSelection().addRange(range);
	});
	await sleep(100);
	// Dispatch the release the painter listens for on the editor root itself.
	await editor.dispatchEvent('mouseup');
	await sleep(400);
	assert.equal(await editor.locator('.rich-block > h2').count(), headingsBefore + paragraphsBefore, 'a multi-block range copies the heading type');
	assert.equal(await editor.locator('.rich-block > p').count(), 0, 'multi-block painting replaces paragraph tags');

	// Plain text is a useful sample: it resets heading type and semantic inline styles.
	await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
	await page.getByLabel('小记正文', { exact: true }).fill('Plain source\n\n## **Bold target**\n');
	await page.getByRole('button', { name: '富文本', exact: true }).click();
	await editor.waitFor(); await sleep(300);
	if (await tools.getByRole('button', { name: '更多', exact: true }).getAttribute('aria-expanded') === 'false') await tools.getByRole('button', { name: '更多', exact: true }).click();
	await collapse('p'); await painter.dblclick();
	assert.equal(await painter.getAttribute('aria-pressed'), 'true');
	await collapse('h2'); await editor.dispatchEvent('mouseup');
	await until(async () => { const body = (await read()).body; return body.includes('Plain source') && body.includes('Bold target') && !/##|\*\*|<h[1-6]\b|<strong\b|<b[ >]/.test(body); });
	assert.equal(await editor.locator('h2,strong,b').count(), 0);
	assert.equal(await painter.getAttribute('aria-pressed'), 'true', 'double click keeps painter armed after applying');
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator(".setup-modal .modal-close").click();
	await page.getByRole('button', { name: '小记', exact: true }).click(); await page.locator('.note-list-item').first().click();
	await editor.waitFor();
	assert.equal(await editor.locator('h2,strong,b').count(), 0, 'plain formatting survives reopening');

	// Clear formatting removes both the block declarations and the format marker. The
	// caret is placed once; clicking back into the editor would drop the pending range.
	await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
	await page.getByLabel('小记正文', { exact: true }).fill('Clear target\n\nplain tail\n');
	await page.getByRole('button', { name: '富文本', exact: true }).click();
	await editor.waitFor(); await sleep(400);
	await editor.locator('.rich-block > p').first().evaluate(el => {
		el.closest('[contenteditable]').focus();
		const range = document.createRange(); range.selectNodeContents(el); range.collapse(true);
		getSelection().removeAllRanges(); getSelection().addRange(range);
	});
	await sleep(150);
	const clearMore = tools.getByRole('button', { name: '更多', exact: true });
	if (await clearMore.getAttribute('aria-expanded') === 'false') await clearMore.click();
	await page.getByLabel('对齐', { exact: true }).selectOption('center');
	await until(async () => await editor.locator('[data-rich-format]').count() === 1);
	if (await clearMore.getAttribute('aria-expanded') === 'false') await clearMore.click();
	await tools.getByRole('button', { name: '清除格式', exact: true }).click();
	// Read the count from the DOM directly: a locator bound before the update can report
	// its previous count even after the editor re-rendered.
	await until(async () => await editor.evaluate(el => el.querySelectorAll('[data-rich-format]').length) === 0);
	assert.equal(await editor.evaluate(el => el.querySelectorAll('[data-rich-format]').length), 0, 'clearing dropped the format marker');
	assert.equal(await editor.locator('.rich-block > p[style]').count(), 0, 'clearing dropped the block declarations');

	// The button explains itself instead of failing silently when nothing is samplable.
	await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
	await page.getByLabel('小记正文', { exact: true }).fill('');
	await page.getByRole('button', { name: '富文本', exact: true }).click();
	await editor.waitFor();
	const moreButton = tools.getByRole('button', { name: '更多', exact: true });
	if (await moreButton.getAttribute('aria-expanded') === 'false') await moreButton.click();
	await until(async () => await tools.getByRole('button', { name: '格式刷', exact: true }).count() === 1);
	// Put the caret in the empty block so the enablement check has something to judge.
	await editor.locator('.rich-block > p, p').first().evaluate(el => {
		el.closest('[contenteditable]')?.focus();
		const range = document.createRange(); range.selectNodeContents(el); range.collapse(true);
		getSelection().removeAllRanges(); getSelection().addRange(range);
	}).catch(() => {});
	await sleep(300);
	const emptyPainter = tools.getByRole('button', { name: '格式刷', exact: true });
	await until(async () => await emptyPainter.isDisabled());
	assert.equal(await emptyPainter.isDisabled(), true, 'nothing to copy disables the painter');
	assert.match(await emptyPainter.getAttribute('title'), /没有可复制的格式/);

	assert.deepEqual(errors, []);
	mkdirSync('tests/scratch', { recursive: true }); await page.screenshot({ path: 'tests/scratch/format-painter-notes.png', fullPage: true });
	console.log('PASS format painter: arm/disarm, Escape, bidirectional types, replace-not-merge, multi-block types, plain reset and reopen, clear, disabled reason');
} finally { await browser?.close(); if (server?.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(r => server.once('exit', r)), sleep(5000)]); if (server.exitCode === null) server.kill('SIGKILL'); } rmSync(root, { recursive: true, force: true }); }
