// Real Electron: the Wiki window is a second BrowserWindow (ADR-0003); closing
// it (or quitting the app) must wait for Wiki saves, including failure.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const base = mkdtempSync(join(tmpdir(), 'wiki-desktop-save-')), cwd = join(base, 'work'), agent = join(base, 'agent');
mkdirSync(cwd); mkdirSync(agent);
writeFileSync(join(cwd, 'README.md'), '# Desktop save\n\nContent.\n');
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ local: { type: 'api_key', key: 'unused' } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: 'unused' }));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { local: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', models: [{ id: 'unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
let app, page, wiki;
const wikiUrls = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => w.webContents.getURL()));
const closeWindow = fragment => app.evaluate(({ BrowserWindow }, f) => { BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes(f))?.close(); }, fragment);
const closeMainWindow = () => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('127.0.0.1') && !w.webContents.getURL().includes('wiki-window=1'))?.close(); });
// Visible state of the MAIN window (Wiki windows excluded — a still-open Wiki
// window would otherwise shadow the lookup).
const windowVisible = fragment => app.evaluate(({ BrowserWindow }, f) => { const w = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes(f) && !w.webContents.getURL().includes('wiki-window=1')); return w ? w.isVisible() : false; }, fragment);
try {
	app = await electron.launch({ args: ['.', `--user-data-dir=${join(base, 'profile')}`], env: { ...process.env, PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: agent } });
	for (let i = 0; i < 200; i++) { page = app.windows().find(p => p.url().startsWith('http://127.0.0.1:')); if (page) break; await sleep(100); }
	assert(page); page.setDefaultTimeout(10000);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.locator('.file-name', { hasText: 'README.md' }).click();
	// Wiki mode opens a second BrowserWindow; the main window stays in normal view.
	for (let i = 0; i < 100; i++) { wiki = app.windows().find(p => p.url().includes('wiki-window=1')); if (wiki) break; await sleep(100); }
	assert(wiki, 'clicking a Markdown file opens the detached Wiki window');
	wiki.setDefaultTimeout(10000);
	assert.equal(await page.locator('.wiki-view:not(.hidden)').count(), 0, 'the main window stays in normal view');
	// The Wiki window is a separate client from the main window (no shared session):
	// its identity lives in the URL client param (ADR-0003), not sessionStorage.
	const mainClient = await page.evaluate(() => sessionStorage.getItem('pi-web-client-id'));
	const wikiClient = new URL(wiki.url()).searchParams.get('client');
	assert(mainClient && wikiClient && mainClient !== wikiClient, 'each window gets its own client id');
	const editor = wiki.locator('.wiki-prose .fp-rich-document'); await editor.waitFor();
	const dragSurface = await wiki.locator('.wiki-view-header').evaluate(header => {
		const toolbar = header.querySelector('#wiki-modal-toolbar');
		const rect = header.getBoundingClientRect();
		const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		const region = element => element ? getComputedStyle(element).getPropertyValue('-webkit-app-region') : 'missing';
		return {
			header: region(header), toolbar: region(toolbar), width: rect.width, height: rect.height,
			hitIsControl: !!hit?.closest('button, input, a, .desktop-window-controls'),
			controls: [...header.querySelectorAll('button, .desktop-window-controls')].map(region),
		};
	});
	assert(dragSurface.width > 600 && dragSurface.height >= 44, 'Wiki has a full-width window header');
	assert.equal(dragSurface.header, 'drag', 'the Wiki window header is a continuous native drag surface');
	assert.equal(dragSurface.toolbar, 'drag', 'the document breadcrumb area also drags the window');
	assert.equal(dragSurface.hitIsControl, false, 'the center of the Wiki header is not covered by an interactive control');
	assert(dragSurface.controls.length > 0 && dragSurface.controls.every(region => region === 'no-drag'), 'Wiki header controls opt out of native dragging');
	await wiki.waitForFunction(() => !document.querySelector('.wiki-send')?.textContent?.includes('会话准备中'));
	// Re-entering reuses the same window instead of spawning more.
	await page.locator('.file-name', { hasText: 'README.md' }).click();
	await sleep(500);
	assert.equal((await wikiUrls()).filter(u => u.includes('wiki-window=1')).length, 1, 're-entering reuses the Wiki window');
	const type = async text => { await editor.locator('p').last().evaluate(el => { el.closest('[contenteditable]').focus(); const r = document.createRange(), s = getSelection(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); }); await wiki.keyboard.type(text); };
	await type(' Saved on close.');
	await closeWindow('wiki-window=1');
	for (let i = 0; i < 100 && (await wikiUrls()).some(u => u.includes('wiki-window=1')); i++) await sleep(50);
	assert.equal((await wikiUrls()).some(u => u.includes('wiki-window=1')), false, 'the Wiki window really closes (no tray hide)');
	assert(readFileSync(join(cwd, 'README.md'), 'utf8').includes('Saved on close.'));
	assert.equal(await windowVisible('127.0.0.1'), true, 'the main window survives the Wiki window closing');

	// Failed saves keep the Wiki window open and the draft intact.
	await page.locator('.file-name', { hasText: 'README.md' }).click();
	for (let i = 0; i < 100; i++) { wiki = app.windows().find(p => p.url().includes('wiki-window=1')); if (wiki && !wiki.isClosed()) break; await sleep(100); }
	wiki.setDefaultTimeout(10000);
	// The reused window is a NEW Page object — rebind the editor to it.
	const reopened = wiki.locator('.wiki-prose .fp-rich-document');
	await reopened.waitFor();
	await wiki.route(/\/api\/wiki(\?|$)/, route => route.request().postDataJSON().action === 'write' ? route.fulfill({ status: 503, json: { error: 'Simulated failure' } }) : route.continue());
	await reopened.locator('p').last().evaluate(el => { el.closest('[contenteditable]').focus(); const r = document.createRange(), s = getSelection(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); });
	await wiki.keyboard.type(' Preserve failed save.');
	await closeWindow('wiki-window=1');
	await wiki.getByRole('button', { name: '保存失败 · 重试', exact: true }).waitFor();
	assert.equal((await wikiUrls()).some(u => u.includes('wiki-window=1')), true, 'failed save keeps the Wiki window');
	assert(!readFileSync(join(cwd, 'README.md'), 'utf8').includes('Preserve failed save.'));
	await wiki.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
	await wiki.getByRole('button', { name: '保存失败 · 重试', exact: true }).click(); await wiki.locator('.wiki-save-status.saved').waitFor();
	// The main window still hides to the tray instead of closing.
	await closeMainWindow();
	for (let i = 0; i < 100 && await windowVisible('127.0.0.1'); i++) await sleep(50);
	assert.equal(await windowVisible('127.0.0.1'), false, 'main window hides to tray');
	assert.equal((await wikiUrls()).some(u => u.includes('127.0.0.1')), true, 'main window is hidden, not destroyed');
	await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('127.0.0.1') && !w.webContents.getURL().includes('wiki-window=1')); w.show(); w.focus(); });
	// Quitting the app waits for the Wiki window's pending save.
	await wiki.locator('.wiki-prose .fp-rich-document').locator('p').last().evaluate(el => { el.closest('[contenteditable]').focus(); const r = document.createRange(), s = getSelection(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); });
	await wiki.keyboard.type(' Saved on quit.');
	await app.close(); app = null;
	assert(readFileSync(join(cwd, 'README.md'), 'utf8').includes('Saved on quit.'));
	console.log('PASS real Electron detached Wiki window: own client, reuse, save before close/quit; failed save keeps the window; main window still hides to tray');
} finally {
	await wiki?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
	// app.close() can hang when the app itself is wedged (e.g. a close guard
	// waiting on an unresponsive window) — bound it so the real failure prints.
	if (app) await Promise.race([app.close(), sleep(15000).then(() => app.process()?.kill('SIGKILL'))]).catch(() => {});
	rmSync(base, { recursive: true, force: true });
}
