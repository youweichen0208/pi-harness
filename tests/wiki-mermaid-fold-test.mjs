// Issue #166: Mermaid source folding in both document hosts must affect computed visibility.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9399;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-toc-test-'));
mkdirSync(join(base, 'agent'));
const original = '# Diagram\n\n```mermaid\nmindmap\n  root((AgentRun))\n    核心定位\n```\n';
writeFileSync(join(base, 'note.md'), original);
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
	const check = async (host) => {
		const code = host.locator('pre > code.language-mermaid');
		const toggle = host.locator('[data-mermaid-source]');
		await toggle.waitFor();
		assert.equal(await code.isVisible(), false, 'Mermaid source defaults to collapsed');
		await toggle.click();
		assert.equal(await code.isVisible(), true, 'click expands source');
		await toggle.click();
		assert.equal(await code.isVisible(), false, 'click collapses source');
		await toggle.focus(); await toggle.press('Enter');
		assert.equal(await code.isVisible(), true, 'keyboard expands source');
		await toggle.press('Space');
		assert.equal(await code.isVisible(), false, 'keyboard collapses source');
		await page.keyboard.press('ControlOrMeta+s');
		await sleep(1000);
		assert.equal((await import('node:fs')).readFileSync(join(base, 'note.md'), 'utf8'), original, 'folding does not change saved Markdown');
	};
	await check(dialog);
	await page.goto(`http://127.0.0.1:${port}/?wiki-window=1&cwd=${encodeURIComponent(base)}&doc=note.md`);
	await check(page.locator('.wiki-workbench'));
	console.log('PASS Mermaid source folds by default, toggles with mouse/keyboard, and preserves Markdown in file and Wiki hosts');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
