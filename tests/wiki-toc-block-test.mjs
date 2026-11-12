// The table of contents is a reading aid: every row is one pointer target, levels stay
// tellable without measuring indentation, and the label/remove action stay subordinate
// to the entries. Guards the refactor described in docs/ui-design.md.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9398;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-toc-test-'));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'note.md'), [
	'# Language', '', '<!-- toc -->', '<!-- /toc -->', '', '一段引言。', '',
	'## 项目与列表', '', '内容。', '',
	'## 文件与对话', '', '内容。', '',
	'### 嵌套小节', '', '内容。', '',
	'## 文档与知识', '', '内容。', '',
].join('\n'));
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
	await dialog.locator('.rich-toc').waitFor();

	const toc = await page.evaluate(() => {
		const node = document.querySelector('.wiki-document-dialog[open] .rich-toc');
		const read = el => {
			const s = getComputedStyle(el), r = el.getBoundingClientRect();
			return { text: el.textContent.trim(), size: s.fontSize, weight: s.fontWeight, color: s.color, height: Math.round(r.height), display: s.display };
		};
		const entries = [...node.querySelectorAll('a')].map(a => ({
			...read(a),
			level: a.parentElement.dataset.tocLevel,
			padLeft: Math.round(parseFloat(getComputedStyle(a).paddingLeft)),
		}));
		return { label: read(node.querySelector('.rich-toc-head strong')), remove: read(node.querySelector('.rich-toc-head button')), entries };
	});
	console.log('toc:', JSON.stringify(toc));

	// 1. Each row is a full-width target of at least 24px (WCAG 2.2 pointer size).
	for (const entry of toc.entries) assert(entry.height >= 24, `an entry row is at least 24px tall (${entry.text}: ${entry.height})`);
	assert(toc.entries.every(entry => entry.display === 'flex'), 'entries are block-level rows, not inline text');
	// 2. Nested levels are inset, and the inset lives on the link so the target grows with it.
	const nested = toc.entries.filter(entry => entry.level === '1');
	assert(nested.length > 0, 'the fixture has a nested entry');
	assert(nested.every(entry => entry.padLeft > 0), `a nested entry is inset (${nested.map(e => e.padLeft)})`);
	assert(toc.entries.filter(entry => entry.level === '0').every(entry => entry.padLeft === 0), 'a top-level entry starts at the card edge');
	// 3. Level is carried by weight as well as by indent, not by indent alone.
	assert.equal(new Set(toc.entries.filter(entry => entry.level === '0').map(entry => entry.weight)).size, 1, 'top-level entries share one weight');
	assert.notEqual(toc.entries.find(entry => entry.level === '0').weight, nested[0].weight, 'a nested entry is lighter than a top-level entry');
	// 4. The label reads as a caption, not as a heading competing with the entries.
	assert(parseFloat(toc.label.size) <= parseFloat(toc.entries[0].size), `the label is not larger than the entries (${toc.label.size} vs ${toc.entries[0].size})`);
	assert.equal(toc.label.weight, '700', 'the label stays the boldest element in the block');
	// 5. The remove action is reachable as a control and never outsizes the entries.
	assert(toc.remove.height >= 20, 'the remove control keeps a usable target');
	assert(parseFloat(toc.remove.size) <= parseFloat(toc.entries[0].size), 'the remove action stays smaller than the entries');

	// 6. The TOC is editor chrome plus anchors: it never rewrites the document.
	await page.keyboard.press('ControlOrMeta+s');
	await page.waitForFunction(() => document.querySelector('.wiki-document-dialog[open]')?.textContent?.includes('已保存') ?? false);
	const saved = (await import('node:fs')).readFileSync(join(base, 'note.md'), 'utf8');
	assert(saved.includes('<!-- toc -->'), `the TOC block itself is preserved:\n${saved}`);
	assert(!saved.includes('data-toc-level'), `no level attributes leak into the file:\n${saved}`);
	assert(!saved.includes('移除目录'), `the remove label never reaches the file:\n${saved}`);

	console.log('PASS table of contents: full-row targets, level via weight and indent, quiet label and remove action');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
