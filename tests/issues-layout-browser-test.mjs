// Regressions for #123-125: file creation, responsive layout and workspace navigation. No model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";

const port = 9361;
assert.equal(await portUp(port), false);
mkdirSync('tests/scratch', { recursive: true });
const base = mkdtempSync(join(tmpdir(), 'issues-layout-'));
const original = '# 构建日志排查\n\n下面是昨晚的构建日志截图。\n\n![构建日志](shot.png)\n\n## 结论\n\n日志文字很小，需要放大查看。\n';
writeFileSync(join(base, 'doc.md'), original);
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
	let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	const failures = [];
	const check = (name, condition, details) => { if (!condition) failures.push(`${name}: ${JSON.stringify(details)}`); };
	await page.setViewportSize({ width: 1079, height: 869 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.screenshot({ path: "tests/scratch/issues-124-narrow.png" });
	const narrow = await page.evaluate(() => {
		const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
		return { left: box(".drawer-left"), main: box(".main"), right: box(".drawer-right"), overlays: document.querySelectorAll('[data-fluid-drawer="overlay"]').length };
	});
	check("#124 desktop panels must remain inline at 1079px", narrow.overlays === 0 && narrow.left.left >= 0 && narrow.left.right <= narrow.main.left + 1 && narrow.right.left >= narrow.main.right - 1, narrow);
	await page.setViewportSize({ width: 2560, height: 1392 });
	await page.screenshot({ path: "tests/scratch/issues-124-wide.png" });
	const wide = await page.evaluate(() => {
		const r = document.querySelector(".main").getBoundingClientRect(), input = document.querySelector(".inputbox").getBoundingClientRect();
		return { width: r.width, input: input.width, gap: input.left - r.left };
	});
	check("#124 chat uses wide available space", wide.input >= wide.width * .7, wide);
	check("#125 remove workspace collapse arrow", await page.locator(".compact-workspace-row .directory-toggle, .compact-workspace-head .directory-toggle, .compact-navigation .directory-toggle").count() === 0, "collapse arrow");
	const popup = page.context().waitForEvent('page');
	await page.locator('.file-name', { hasText: 'doc.md' }).click();
	page = await popup;
	await page.setViewportSize({ width: 2560, height: 1392 });
	await page.locator('.wiki-prose .fp-rich-document').waitFor();
	await page.screenshot({ path: "tests/scratch/issues-124-wiki.png" });
	const wiki = await page.evaluate(() => {
		const article = document.querySelector(".wiki-document").getBoundingClientRect(), sidebar = document.querySelector(".wiki-sidebar").getBoundingClientRect();
		return { gap: article.left - sidebar.right, width: article.width };
	});
	check("#124 wiki document stays close to tree", wiki.gap <= 64, wiki);
	const create = page.locator('.wiki-sidebar').getByRole('button', { name: '新建文件', exact: true });
	check("#123 visible labeled file creation", (await create.innerText()).includes("新建文件"), await create.innerText());
	await create.click();
	await page.locator('.create-file-form input').fill('new-note.md');
	await page.locator('.create-file-form button[type=submit]').click();
	await page.waitForFunction(() => new URL(location.href).searchParams.get("doc") === "new-note.md");
	assert.equal(readFileSync(join(base, 'new-note.md'), 'utf8'), '');
	await page.reload();
	await page.locator('.wiki-prose .fp-rich-document').waitFor();
	check("new document persists after reload", new URL(page.url()).searchParams.get("doc") === "new-note.md", page.url());
	assert.deepEqual(failures, []);

	assert.deepEqual(errors, []);
	console.log('PASS issue layouts, Wiki file creation and workspace navigation');
} finally {
	if (browser) await browser.close();
	if (server) server.kill();
	rmSync(base, { recursive: true, force: true });
}
