// #116/#117: detached Wiki chat defaults, live outline, heading caret and table boundaries.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";

const port = 9319;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'wiki-issues-'));
writeFileSync(join(base, 'table.md'), '# Table\n\n| A | B |\n| --- | --- |\n| One | Two |\n');
writeFileSync(join(base, 'note.md'), '# Outline document\n\n## First\n\nIntro\n\n### Repeated\n\n' + 'Body paragraph.\n\n'.repeat(30) + '#### Deep\n\nDeep body\n\n## Second\n\n### Repeated\n\n' + 'More content.\n\n'.repeat(30) + '##### Skipped level\n\nLast section\n');
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
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	const popup = page.context().waitForEvent('page');
	await page.locator('.file-name', { hasText: 'note.md' }).click();
	page = await popup;
	page.setDefaultTimeout(10000);
	const editor = page.locator('.wiki-prose .fp-rich-document');

	await editor.waitFor();
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	const outline = page.locator('.wiki-outline');
	const links = outline.locator('.wiki-outline-link');
	await page.waitForFunction(() => document.querySelectorAll('.wiki-outline-link').length === 7);
	const surface = await page.evaluate(() => {
		const scroll = document.querySelector('.wiki-scroll');
		const outline = document.querySelector('.wiki-outline-aside');
		return { right: scroll.getBoundingClientRect().right, edge: document.querySelector('.wiki-window-body').getBoundingClientRect().right, inside: scroll.contains(outline), border: getComputedStyle(outline).borderLeftWidth };
	});
	assert(surface.inside && Math.abs(surface.right - surface.edge) <= 1, JSON.stringify(surface));
	assert.equal(surface.border, '0px');
	await outline.hover();
	await page.mouse.wheel(0, 300);
	await page.waitForFunction(() => document.querySelector('.wiki-scroll').scrollTop > 100);
	await page.locator('.wiki-scroll').evaluate(el => el.scrollTop = 0);
	assert.deepEqual(await links.allTextContents(), ['Outline document', 'First', 'Repeated', 'Deep', 'Second', 'Repeated', 'Skipped level']);
	assert.equal(await links.last().evaluate(el => { let count=0; for(let p=el.parentElement;p;p=p.parentElement) if(p.tagName==='UL') count++;return count; }), 4, 'skipped heading levels use actual ancestry');
	const fold = title => outline.locator('.wiki-outline-row').filter({has: page.locator('.wiki-outline-link', {hasText: new RegExp(`^${title}$`)})}).locator('.wiki-outline-fold');
	await fold('First').click();
	assert.equal(await fold('First').getAttribute('aria-expanded'), 'false');
	assert.deepEqual(await links.allTextContents(), ['Outline document','First','Second','Repeated','Skipped level']);
	await editor.locator('h4').evaluate(el => el.scrollIntoView({block:'start'}));
	await page.waitForFunction(() => document.querySelector('.wiki-outline-link[aria-current]')?.textContent === 'First');
	assert.equal(await fold('First').getAttribute('aria-expanded'), 'false', 'scroll tracking must not reopen a collapsed branch');
	await fold('First').press('Enter');
	await page.waitForFunction(() => document.querySelector('.wiki-outline-link[aria-current]')?.textContent === 'Deep');
	// Duplicate headings navigate via DOM references, never text lookup.
	await links.filter({hasText:/^Repeated$/}).nth(1).click();
	await page.waitForFunction(() => {
		const matches=[...document.querySelectorAll('.wiki-outline-link')].filter(el=>el.textContent==='Repeated');
		return matches[1]?.getAttribute('aria-current')==='location';
	});
	await outline.locator('.wiki-outline-tools button').nth(1).click();
	assert.deepEqual(await links.allTextContents(), ['Outline document']);
	await outline.locator('.wiki-outline-tools button').nth(1).click();
	assert.equal(await links.count(), 7);
	await outline.locator('.wiki-outline-tools button').first().click();
	assert.equal(await links.count(), 0);
	assert.equal(await outline.locator('.wiki-outline-tools button').nth(1).isDisabled(), true);
	await outline.locator('.wiki-outline-tools button').first().press('Enter');
	assert.equal(await links.count(), 7);
	// Heading edits update the live tree without losing another branch's state.
	await fold('First').click();
	await editor.locator('h2').last().fill('Second updated');
	await outline.locator('.wiki-outline-link', {hasText:'Second updated'}).waitFor();
	assert.equal(await fold('First').getAttribute('aria-expanded'), 'false');
	await page.locator('.wiki-source-toggle').click();
	await outline.locator('p').waitFor();
	await page.locator('.wiki-source-toggle').click();
	await editor.waitFor();
	await page.waitForFunction(() => document.querySelectorAll('.wiki-outline-link').length === 7);
	await page.keyboard.press('ControlOrMeta+s');
	await page.locator('.wiki-save-status.saved').waitFor();
	assert(!readFileSync(join(base,'note.md'),'utf8').includes('wiki-outline'));
	await fold('First').click();
	await page.locator('.wiki-tree-row[title="table.md"]').click();
	await page.waitForFunction(() => document.querySelector('.wiki-outline-link')?.textContent === 'Table');
	await page.locator('.wiki-tree-row[title="note.md"]').click();
	await page.waitForFunction(() => document.querySelectorAll('.wiki-outline-link').length === 7);
	assert.equal(await fold('First').getAttribute('aria-expanded'), 'true', 'document changes reset disclosure state');
	await page.locator('.wiki-scroll').evaluate(el=>el.scrollTop=0);
	await page.waitForFunction(() => document.querySelector('.wiki-outline-link[aria-current]')?.textContent === 'Outline document');
	await page.screenshot({path:'/tmp/pi-outline-tree.png'});
	await page.evaluate(()=>document.documentElement.dataset.appearance='dark');
	await page.screenshot({path:'/tmp/pi-outline-tree-dark.png'});
	await page.locator('.wiki-ask-toggle').click();
	await page.getByRole('button', { name: '固定到右侧', exact: true }).click();
	assert.equal(await page.locator('.wiki-reading-layout .wiki-outline-aside').count(), 0);
	await page.locator('.wiki-ask-toggle').click();
	await page.locator('.wiki-reading-layout .wiki-outline-aside').waitFor();
	await page.setViewportSize({ width: 390, height: 850 });
	await page.locator('.wiki-window-header').getByRole('button', { name: '目录', exact: true }).click();
	await page.locator('.wiki-outline-aside').waitFor();
	assert.equal(await page.locator('.wiki-reading-layout .wiki-outline-aside').count(), 0);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	await page.locator('.wiki-outline-close').click();
	assert.deepEqual(errors, []);
	console.log('PASS outline hierarchy, disclosures, show/hide, scroll tracking, duplicates, edits and document switching');
} finally {
	await browser?.close();
	if (server) { server.kill('SIGTERM'); if(server.exitCode===null) await new Promise(resolve=>server.once('exit',resolve)); }
	rmSync(base, {recursive:true,force:true});
}
