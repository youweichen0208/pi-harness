import { openKnowledge } from "./lib/open-knowledge.mjs";
// Current-document sync uses real filesystem versions, independently of the cached index.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";
const port = 8996;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-document-sync-')), cwd = join(base, 'work'), agent = join(base, 'agent');
mkdirSync(cwd); mkdirSync(agent);
writeFileSync(join(agent, "auth.json"), JSON.stringify({ local: { type: "api_key", key: "unused" } }));
writeFileSync(join(cwd, 'README.md'), '# Editing workbench\n\nA paragraph to select and edit.\n\n## Section\n\nAnother paragraph.\n');
writeFileSync(join(cwd, 'linked.markdown'), '# Linked Markdown\n\nLinked text.\n');
writeFileSync(join(cwd, 'other.md'), '# Other\n\nOther content.\n');
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { local: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', models: [{ id: 'unused', name: 'Local model', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: 'unused' }));
const server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, page, failWrite = false, taskRunning = false;
server.stdout.resume(); server.stderr.resume();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const disk = () => readFileSync(join(cwd, 'README.md'), 'utf8');
try {
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	await page.context().route('**/api/wiki', async route => {
		const body = route.request().postDataJSON();
		if (body.action === 'state') {
			const response = await route.fetch();
			return route.fulfill({ json: { ...await response.json(), running: taskRunning } });
		}
		if (body.action === 'write') {
			if (failWrite) return route.fulfill({ status: 503, json: { error: 'Temporary save failure' } });
			const response = await route.fetch();
			return route.fulfill({ response });
		}
		await route.continue();
	});
	await page.clock.install();
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	const popup = page.waitForEvent("popup");
	await openKnowledge(page, cwd, "README.md");
	page = await popup;
	page.setDefaultTimeout(5000);
	const editor = page.locator('.wiki-prose .fp-rich-document');
	await editor.waitFor();
	// The index can lag behind filesystem writes by the native agent.
	// Keep its entries unchanged to verify the opened file is observed directly.
	await page.waitForTimeout(500);
	taskRunning = true;
	await page.clock.fastForward(31000);
	await page.waitForFunction(() => document.querySelector('.fp-rich-document')?.getAttribute('contenteditable') === 'false');
	writeFileSync(join(cwd, 'README.md'), '# Editing workbench\n\nAgent updated this document.\n');
	await page.clock.fastForward(1100);
	await page.waitForFunction(() => document.querySelector('.wiki-prose .fp-rich-document')?.textContent.includes('Agent updated this document.'), undefined, { timeout: 5000 });
	taskRunning = false;
	await page.clock.fastForward(1100);
	await page.waitForFunction(() => document.querySelector('.fp-rich-document')?.getAttribute('contenteditable') === 'true');
	await editor.locator('p').last().click();
	await page.keyboard.press('End');
	await page.keyboard.type(' Local follow-up.');
	await page.keyboard.press('Meta+s');
	await page.waitForFunction(() => !!document.querySelector('.wiki-save-status.saved'));
	assert(disk().includes('Agent updated this document.'));
	assert(disk().includes('Local follow-up.'));
	assert.equal(await page.locator('.wiki-conflict').count(), 0);
	failWrite = true;
	await page.keyboard.type(' Unsaved draft.');
	await page.keyboard.press('Meta+s');
	await page.locator('.wiki-save-status.failed').waitFor();
	writeFileSync(join(cwd, 'README.md'), '# External replacement\n');
	await page.clock.fastForward(31000);
	await page.locator('.wiki-conflict').waitFor();
	assert((await editor.innerText()).includes('Unsaved draft.'));
	assert.equal(disk(), '# External replacement\n');
	assert.deepEqual(errors, []);
	console.log('PASS running-task document sync, subsequent save with latest version, and unsaved draft protection');
} finally {
	await page?.context().unrouteAll({ behavior: 'ignoreErrors' }); await browser?.close();
	server.kill('SIGTERM'); await new Promise(r => server.once('exit', r));
	rmSync(base, { recursive: true, force: true });
}
