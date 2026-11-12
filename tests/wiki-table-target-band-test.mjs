// Verify the row target paints as one continuous band: the gutter follows the
// row highlight instead of staying grey (docs/adr/0007 eighth item). The band
// belongs to the gutter gesture (click the row's gutter), not the structure menu.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9389;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-gutter-band-'));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'note.md'), '# Band\n\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |\n');
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
	const table = dialog.locator('.wiki-prose .fp-rich-document table').first();
	await table.waitFor();

	const state = () => page.evaluate(() => {
		const table = document.querySelector('.wiki-document-dialog[open] .wiki-prose table');
		const targeted = table.querySelector('tr[data-row-target]');
		const gutter = table.querySelector('td[data-rich-gutter]');
		const rowCell = targeted?.querySelector('td:not([data-rich-gutter])');
		const otherGutter = [...table.querySelectorAll('td[data-rich-gutter]')].find(cell => !targeted?.contains(cell));
		const bg = node => node ? getComputedStyle(node).backgroundColor : null;
		return {
			highlightedGutter: bg(gutter),
			highlightedCell: bg(rowCell),
			idleGutter: bg(otherGutter),
			gutterClip: gutter ? getComputedStyle(gutter).backgroundClip : null,
		};
	});

	const idle = await state();
	console.log('idle:', JSON.stringify(idle));

	// The row band comes from the gutter gesture; the structure menu marks one cell only.
	await table.locator('tbody tr').first().locator('td[data-rich-gutter]').first().click();
	await sleep(300);
	const active = await state();
	console.log('targeted row:', JSON.stringify(active));

	assert.equal(active.highlightedGutter, active.highlightedCell, 'the gutter of a targeted row shares the row highlight colour');
	assert.notEqual(active.highlightedGutter, idle.idleGutter, 'the targeted gutter is no longer the idle grey');
	assert.equal(active.gutterClip, 'content-box', 'the gutter keeps its inset shape');
	console.log('PASS row target band: the gutter follows the row highlight and keeps its content-box shape');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
