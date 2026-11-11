import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { playgroundFixture } from './lib/playground-fixture.mjs';
const fixture = await playgroundFixture();
let browser;
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	const stamp = Date.now();
	const messages = Array.from({ length: 4 }, (_, i) => [
		{ id: `u${i}`, role: 'user', timestamp: stamp + i * 1000, content: [{ type: 'text', text: `Q${i * 2 + 1} 采集器故障：现在检查日志并修复\nQ${i * 2 + 2} 本轮目标：(a) 验证真实闭环\n\n补充说明：保持原有部署。` }] },
		{ id: `a${i}`, role: 'assistant', model: 'test-model', timestamp: stamp + i * 1000 + 100, content: [{ type: 'text', text: `Confirmed. 第 ${i + 1} 轮回复完整正文。\n\n1. 检查日志，定位 **根本原因**。\n2. 验证修复结果，检查 \`metadata.json\`。` }] },
	]).flat();
	messages.splice(7, 0,
		{ id: 'tool', role: 'assistant', model: 'test-model', timestamp: stamp + 3050, content: [{ type: 'toolCall', id: 'read1', name: 'read', argumentsText: '{"path":"metadata.json"}' }] },
		{ id: 'result', role: 'toolResult', toolCallId: 'read1', toolName: 'read', timestamp: stamp + 3060, isError: false, content: [{ type: 'text', text: '{}' }] });
	let base;
	await page.routeWebSocket(/\/ws(?:\?|$)/, route => {
		const upstream = route.connectToServer();
		route.onMessage(w => upstream.send(w));
		upstream.onMessage(w => {
			const m = JSON.parse(String(w));
			if (m.type === 'snapshot' || m.type === 'snapshot_delta') {
				base = { ...base, ...m.state };
				route.send(JSON.stringify({ type: 'snapshot', state: { ...base, piConfigured: true, isStreaming: false, messages, streamingMessage: null, taskProgress: null } }));
			} else route.send(w);
		});
	});
	await page.goto(`${fixture.base}/?token=${fixture.token}`);
	await page.locator('.answer-summary').first().waitFor();
	// History is always expanded: every round renders, and the "expand older
	// rounds" control no longer exists. Four rounds → 4 summary blocks, each
	// carrying the 2 questions answered that round.
	assert.equal(await page.locator('.answer-summary').count(), 4);
	assert.equal(await page.locator('.answer-summary-item').count(), 8);
	assert.equal(await page.locator('.answer-history-expand').count(), 0);
	assert.equal(await page.locator('.process-group.ok').count(), 1);
	// A single tool call renders headless: the summary line stands in for the
	// toggle head, and the tool row is visible without a click.
	assert.equal(await page.locator('.process-group-head').count(), 0);
	assert.equal(await page.locator('.process-group-summary-line').count(), 1);
	// Every round is present as its own assistant message (4 replies + the tool
	// call message), all mounted without any click.
	assert.equal(await page.locator('.msg-assistant').count(), 5);
	await page.locator('.messages').evaluate(el => el.scrollTop = 0);
	mkdirSync('tests/scratch', { recursive: true });
	await page.screenshot({ path: 'tests/scratch/answer-history-desktop.png' });
	// Oldest round is rendered from the start, with its original user prompt.
	assert.match(await page.locator('.msg-user').first().textContent(), /补充说明：保持原有部署/);
	await page.keyboard.press('Control+f');
	await page.locator('.search-bar input').fill('第 1 轮回复完整正文');
	await page.locator('.msg-assistant[data-msg-id="a0"]').waitFor();
	assert.equal(await page.locator('.answer-summary').count(), 4, 'oldest group renders without unfolding');
	await page.keyboard.press('Escape');
	await page.evaluate(() => document.documentElement.setAttribute('data-appearance', 'dark'));
	await page.screenshot({ path: 'tests/scratch/answer-history-dark.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(400);
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	await page.screenshot({ path: 'tests/scratch/answer-history-mobile.png' });
	assert.deepEqual(errors, []);
	console.log('PASS answer summaries, full history rendering, full replies, shared model header, tool expansion, search, dark and mobile');
} finally { await browser?.close(); await fixture.stop(); }
