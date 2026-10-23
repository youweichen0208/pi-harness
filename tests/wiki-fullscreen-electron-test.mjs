import { openKnowledge } from "./lib/open-knowledge.mjs";
// Issue #89: Electron paints the fullscreen page over the open document dialog unless it is restacked.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'pi-wiki-fullscreen-'))), cwd = join(base, 'workspace'), agent = join(base, 'agent');
mkdirSync(cwd); mkdirSync(agent);
writeFileSync(join(cwd, 'README.md'), '# Fullscreen entry\n\n' + Array.from({ length: 60 }, (_, i) => `Paragraph ${i}.\n\n`).join(''));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));
let app;
try {
	app = await electron.launch({ args: ['.', `--user-data-dir=${join(base, 'profile')}`], env: { ...process.env, PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: agent } });
	let page;
	for (let i = 0; i < 200; i++) { page = app.windows().find(w => w.url().startsWith('http://127.0.0.1:')); if (page) break; await new Promise(r => setTimeout(r, 100)); }
	assert(page); page.setDefaultTimeout(15000);
	await openKnowledge(page, cwd, "README.md");
	await page.locator('.wiki-prose .fp-rich-document').waitFor();
	await page.locator('.wiki-scroll').evaluate(el => { el.scrollTop = 300; el.style.background = 'rgb(0, 255, 0)'; });
	// macOS ignores leaving fullscreen mid-animation; enter-full-screen fires once the window has settled.
	const entered = app.evaluate(({ BrowserWindow }) => new Promise(resolve => BrowserWindow.getAllWindows()[0].once('enter-full-screen', resolve)));
	await page.getByRole('button', { name: '全屏显示文档', exact: true }).click();
	await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
	await entered;
	// Hit-testing already reaches the dialog; only the painted pixels show the page covering it.
	const visible = () => app.evaluate(async ({ BrowserWindow }) => {
		const image = await BrowserWindow.getAllWindows()[0].capturePage(), { width, height } = image.getSize(), bitmap = image.toBitmap(), at = (Math.floor(height / 2) * width + Math.floor(width / 4)) * 4;
		return bitmap[at] < 40 && bitmap[at + 1] > 200 && bitmap[at + 2] < 40; // BGRA green
	});
	let painted = false;
	for (let i = 0; i < 30 && !(painted = await visible()); i++) await new Promise(r => setTimeout(r, 100));
	assert(painted, 'fullscreen document dialog is painted above the page');
	assert.equal(await page.locator('.wiki-scroll').evaluate(el => el.scrollTop), 300);
	const left = () => app.evaluate(({ BrowserWindow }) => new Promise(resolve => BrowserWindow.getAllWindows()[0].once('leave-full-screen', resolve)));
	let leaving = left();
	await page.getByRole('button', { name: '退出全屏', exact: true }).click();
	await page.waitForFunction(() => !document.fullscreenElement);
	await leaving;
	assert(await page.locator('.wiki-document-dialog').evaluate(el => el.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2))));
	// Restoring or closing during the enter animation still leaves once the window settles.
	for (const leave of [() => page.getByRole('button', { name: '退出全屏', exact: true }).click(), () => page.locator('.wiki-modal-header > button').last().click()]) {
		leaving = left();
		await page.getByRole('button', { name: '全屏显示文档', exact: true }).click();
		await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
		await leave();
		await page.waitForFunction(() => !document.fullscreenElement);
		await leaving;
		assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false);
	}
	await page.locator('.wiki-document-dialog').waitFor({ state: 'detached' });
	console.log('PASS Electron document fullscreen keeps the dialog visible and leaves even mid-animation');
} finally { await app?.close(); rmSync(base, { recursive: true, force: true }); }
