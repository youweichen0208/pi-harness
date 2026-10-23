import { openKnowledge } from "./lib/open-knowledge.mjs";
// Actual Electron /table insertion: document sizing must survive .msg-text ancestry.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'pi-wiki-table-'))), cwd = join(base, 'workspace'), agent = join(base, 'agent');
mkdirSync(cwd); mkdirSync(agent);
writeFileSync(join(cwd, 'README.md'), '# Table insertion\n\nInsert here.\n');
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
	const editor = page.locator('.wiki-prose .fp-rich-document');
	await editor.waitFor();
	await editor.locator('p').last().fill('');
	await page.keyboard.type('/table');
	await page.getByRole('option', { name: '插入表格', exact: true }).click();
	await page.locator('.wiki-table-grid button').nth(18).click();
	const table = editor.locator('table').first();
	await table.waitFor();
	await editor.locator('table.rich-table-empty').waitFor(); // class applied after the onChange roundtrip
	const measure = () => table.evaluate(el => ({
		width: el.getBoundingClientRect().width,
		grid: el.querySelector('thead').getBoundingClientRect().width,
		prose: el.closest('.wiki-prose').getBoundingClientRect().width,
		empty: el.classList.contains('rich-table-empty'),
		html: el.outerHTML,
		parent: el.parentElement.outerHTML.slice(0, 160),
	}));
	const inserted = await measure();
	assert.equal(await table.locator('tr').count(), 3);
	assert.equal(await table.locator('th').count(), 3);
	assert(inserted.empty, 'fresh 3x3 template is marked empty');
	assert(inserted.width - inserted.grid <= 3, 'inserted table has empty space beside columns');
	assert(inserted.width >= inserted.prose - 3, `empty template must fill the prose width: ${JSON.stringify(inserted)}`);
	await table.locator('td').first().fill('Saved cell');
	await page.keyboard.press('ControlOrMeta+s');
	await page.locator('.wiki-save-status.saved').waitFor();
	assert(readFileSync(join(cwd, 'README.md'), 'utf8').includes('Saved cell'));
	await page.reload();
	await openKnowledge(page, cwd, "README.md");
	await table.waitFor();
	const reopened = await measure();
	assert(reopened.width - reopened.grid <= 3, 'reopened table has empty space beside columns');
	assert(!reopened.empty, 'table with saved content is no longer an empty template');
	assert(reopened.width < reopened.prose - 3, 'content table shrinks to its columns');
	assert.equal(await table.locator('td').first().textContent(), 'Saved cell');
	if (process.env.PI_TABLE_SCREENSHOT) await page.screenshot({ path: process.env.PI_TABLE_SCREENSHOT });
	console.log('PASS Electron /table -> 3x3: no blank right area, cell editing, save and reopen');
} finally { await app?.close(); rmSync(base, { recursive: true, force: true }); }
