/** Replay a real local grill-with-docs response (#148); never call a model. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
const reply = readFileSync(new URL('./fixtures/grill-colon-options.md', import.meta.url), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'pi-question-colon-'));
let server, browser;
try {
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	for (const lang of ['zh', 'en']) {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		page.setDefaultTimeout(10000);
		await page.addInitScript(lang => localStorage.setItem('pi-harness:lang', lang), lang);
		const sent = [];
		let seeded = false;
		await page.routeWebSocket('**/ws', route => {
			const upstream = route.connectToServer();
			route.onMessage(raw => {
				const message = JSON.parse(String(raw));
				if (message.type === 'prompt') { sent.push(message); route.send(JSON.stringify({ type: 'prompt_result', requestId: message.requestId, ok: true })); }
				else upstream.send(raw);
			});
			upstream.onMessage(raw => {
				const message = JSON.parse(String(raw));
				if (message.type === 'snapshot' && seeded) return;
				if (message.type === 'snapshot') { seeded = true; Object.assign(message.state, { tree: message.state.tree ? { ...message.state.tree, verifying: false } : undefined, piConfigured: true, isStreaming: false, streamingMessage: null, messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: '核对方案' }] }, { id: 'a', role: 'assistant', content: [{ type: 'text', text: reply }] }] }); }
				if (message.type !== 'snapshot_delta') route.send(JSON.stringify(message));
			});
		});
		await page.goto(`http://127.0.0.1:${server.port}`);
		await page.locator('.question-card').nth(7).waitFor();
		const counts = [3, 3, 3, 4, 3, 3, 3, 3];
		for (let i = 0; i < counts.length; i++) {
			const card = page.locator('.question-card').nth(i), toggle = card.locator('.question-heading-toggle');
			assert.equal(await card.locator('button.question-option').count(), counts[i]);
			assert.equal((await toggle.innerText()).includes('**'), false);
		}
		const first = page.locator('.question-card').first();
		if (await first.locator('.question-heading-toggle').getAttribute('aria-expanded') !== 'true') await first.locator('.question-heading-toggle').click();
		await first.locator('button.question-option').nth(1).click();
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(200);
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
		mkdirSync('tests/scratch', { recursive: true });
		await page.screenshot({ path: `tests/scratch/issue148-fixed-${lang}.png` });
		await page.locator('.question-answer-bar button').last().click();
		await page.waitForFunction(() => document.querySelector('.inputbox textarea')?.value === '');
		for (let i = 0; i < 50 && !sent.length; i++) await page.waitForTimeout(100);
		assert.equal(sent.length, 1);
		assert.match(sent[0].text, /Q1.*\(b\) 同一逻辑会话内换类型/);
		console.log(`PASS ${lang}: all 25 original options, clean headings, narrow layout and non-recommended answer payload`);
		await page.close();
	}
} finally { await browser?.close(); await server?.stop(); rmSync(root, { recursive: true, force: true }); }
