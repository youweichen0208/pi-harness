// The two left strips must not look alike: a data row's strip selects that row and
// says so on hover; the header's strip only aligns the columns and does nothing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9397;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-gutter-affordance-'));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'note.md'), '# Gutter\n\n| 列 1 | 列 2 |\n| --- | --- |\n| a | b |\n| c | d |\n');
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
	await dialog.locator('.wiki-prose .fp-rich-document table').first().waitFor();

	// Appearance and hint: the two strips are distinguishable without clicking.
	const look = await page.evaluate(() => {
		const t = document.querySelector('.wiki-document-dialog[open] .wiki-prose table');
		const read = cell => ({
			tag: cell.tagName,
			cursor: getComputedStyle(cell).cursor,
			title: cell.getAttribute('title'),
			hidden: cell.getAttribute('aria-hidden'),
			width: Math.round(cell.getBoundingClientRect().width),
		});
		return { header: read(t.querySelector('th[data-rich-gutter]')), body: read(t.querySelector('td[data-rich-gutter]')) };
	});
	console.log('strips:', JSON.stringify(look));
	assert.equal(look.header.cursor, 'default', `the header spacer does not look clickable (got ${look.header.cursor})`);
	assert.equal(look.header.title, null, 'the header spacer advertises no action');
	assert.equal(look.body.cursor, 'pointer', `a data row strip looks clickable (got ${look.body.cursor})`);
	assert.equal(look.body.title, '选择整行', `a data row strip says what it does (got ${look.body.title})`);
	assert.equal(look.header.hidden, 'true', 'both strips stay out of the accessibility tree');
	assert.equal(look.body.hidden, 'true', 'both strips stay out of the accessibility tree');
	assert.equal(look.header.width, 14, 'the header spacer stays 14px wide');
	assert.equal(look.body.width, 14, 'a data row strip stays 14px wide');

	// Behaviour: the header spacer is a no-op, a data row strip selects its row.
	const press = async selector => {
		await dialog.locator('.wiki-document-heading').click();
		await sleep(150);
		const box = await page.locator(selector).first().boundingBox();
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		await sleep(250);
		return page.evaluate(() => {
			const t = document.querySelector('.wiki-document-dialog[open] .wiki-prose table');
			return { rowTarget: t.querySelectorAll('tr[data-row-target]').length, tableSelected: t.hasAttribute('data-table-selected') };
		});
	};
	const headerPress = await press('th[data-rich-gutter]');
	assert.deepEqual(headerPress, { rowTarget: 0, tableSelected: false }, `a press on the header spacer does nothing (got ${JSON.stringify(headerPress)})`);
	const bodyPress = await press('tbody td[data-rich-gutter]');
	assert.equal(bodyPress.rowTarget, 1, `a press on a data row strip selects that row (got ${JSON.stringify(bodyPress)})`);

	// The row strip never leaks into saved Markdown.
	await page.keyboard.press('ControlOrMeta+s');
	await page.waitForFunction(() => document.querySelector('.wiki-document-dialog[open]')?.textContent?.includes('已保存') ?? false);
	const saved = (await import('node:fs')).readFileSync(join(base, 'note.md'), 'utf8');
	assert(!saved.includes('data-rich-gutter'), `the gutter is editor chrome only:\n${saved}`);
	assert(!saved.includes('选择整行'), `the hint never reaches the file:\n${saved}`);

	console.log('PASS gutter affordance: the header spacer is inert chrome, the data strip is a labelled row control');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
