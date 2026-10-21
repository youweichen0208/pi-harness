// Wiki tree media files open as read-only previews without binding a document
// conversation (issue #119): no error, the chat stays usable, and switching
// back to the document restores its own conversation. No model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";

const port = 9354;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-media-preview-'));
writeFileSync(join(base, 'doc.md'), '# 构建日志排查\n\n正文。\n');
copyFileSync(join(import.meta.dirname, '../build/icon.png'), join(base, 'shot.png'));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(base, 'agent/auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));
let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	const page = await context.newPage();
	page.setDefaultTimeout(10000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	const popupPromise = context.waitForEvent('page');
	await page.locator('.file-name', { hasText: 'doc.md' }).click();
	const popup = await popupPromise;
	popup.setDefaultTimeout(10000);
	popup.on('pageerror', error => errors.push(error.message));
	await popup.locator('.wiki-prose .fp-rich-document').waitFor();

	// 1. Clicking an image in the tree opens the read-only preview, no error.
	await popup.locator('.wiki-tree-row', { hasText: 'shot.png' }).locator('.wiki-tree-main').click();
	const image = popup.locator('.wiki-document img.wiki-image');
	await image.waitFor();
	assert.equal((await image.getAttribute('src'))?.includes('/api/wiki-media'), true);
	assert.equal(await popup.locator('.wiki-error').count(), 0);
	assert.equal(await popup.locator('.notice-error').count(), 0);
	assert.equal(new URL(popup.url()).searchParams.get('doc'), 'shot.png');

	// 2. Media previews carry no text context: no current-file chip, but the
	// chat composer stays enabled (the document conversation is still attached).
	await popup.locator('.wiki-ask-toggle').click();
	const composer = popup.locator('.wiki-assistant .inputbox textarea');
	await composer.waitFor();
	assert.equal(await composer.isDisabled(), false);
	assert.equal(await popup.locator('.wiki-assistant .inputbox .current-file').count(), 0);

	// 3. Switching back to the document restores the editor and its conversation.
	await popup.locator('.wiki-tree-row', { hasText: 'doc.md' }).locator('.wiki-tree-main').click();
	await popup.locator('.wiki-prose .fp-rich-document').waitFor();
	assert.equal(await popup.locator('.wiki-error').count(), 0);
	assert.equal(new URL(popup.url()).searchParams.get('doc'), 'doc.md');

	assert.deepEqual(errors, []);
} finally {
	if (browser) await browser.close();
	if (server) server.kill();
	rmSync(base, { recursive: true, force: true });
}
