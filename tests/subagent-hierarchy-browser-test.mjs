/** Zero-token compatibility regression: legacy calls share the new task-list/drawer renderer. */
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
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	const item = (index, status = 'completed') => ({ sourceId: 'same-repository', source: 'pi-web-ui', root: fixture.root, task: `调查任务 ${index}`, status, text: status === 'failed' ? 'Error: interrupted' : `任务 ${index} 的结论`, evidenceStatus: 'unverified', durationMs: 1000, steps: [{ id: `read-${index}`, tool: 'source_read', target: 'server/index.ts', status: 'completed', durationMs: 10 }] });
	const messages = [{ id: 'u', role: 'user', content: [{ type: 'text', text: '调查多个问题' }] }];
	const addCall = (id, results) => {
		messages.push({ id: `a-${id}`, role: 'assistant', content: [{ type: 'toolCall', id, name: 'subagent', argumentsText: JSON.stringify({ action: 'run', tasks: results.map(({ sourceId, task }) => ({ sourceId, task })) }) }] });
		messages.push({ id: `r-${id}`, role: 'toolResult', toolCallId: id, toolName: 'subagent', content: [{ type: 'text', text: JSON.stringify({ results }) }] });
	};
	addCall('first', [item(1), item(2, 'failed')]);
	messages.push({ id: 'comment', role: 'assistant', content: [{ type: 'text', text: '继续调查其他问题' }] });
	const old = item(3); delete old.steps;
	addCall('second', [old]);
	let base;
	await page.routeWebSocket(/\/ws(?:\?|$)/, route => {
		const upstream = route.connectToServer(); route.onMessage(w => upstream.send(w));
		upstream.onMessage(w => {
			const m = JSON.parse(String(w));
			if (m.type === 'snapshot' || m.type === 'snapshot_delta') {
				base = { ...base, ...m.state };
				route.send(JSON.stringify({ type: 'snapshot', state: { ...base, piConfigured: true, isStreaming: false, messages, streamingMessage: null, taskProgress: null } }));
			} else route.send(w);
		});
	});
	await page.goto(`${fixture.base}/?token=${fixture.token}`);
	await page.locator('.subagent-task-group').waitFor();
	assert.equal(await page.locator('.subagent-task-group').count(), 1);
	assert.equal(await page.locator('.subagent-task-row').count(), 0, 'completed groups default collapsed');
	await page.locator('.subagent-task-group-head').click();
	assert.equal(await page.locator('.subagent-task-row').count(), 2, 'failures start hidden');
	await page.locator('.subagent-task-row').first().click();
	await page.locator('.subagent-task-result').waitFor();
	assert.match(await page.locator('.subagent-task-result').innerText(), /任务 1 的结论/);
	await page.getByRole('button', { name: '执行过程', exact: true }).click();
	assert.equal(await page.locator('.subagent-task-timeline li').count(), 1);
	await page.keyboard.press('Escape');
	assert.equal(await page.locator('.subagent-drawer').count(), 0);
	assert(await page.locator('.subagent-task-row').first().evaluate(el => el === document.activeElement));
	await page.locator('.subagent-task-row').nth(1).click();
	await page.getByRole('button', { name: '执行过程', exact: true }).click();
	assert.match(await page.locator('.subagent-drawer-content').innerText(), /此记录未保存执行步骤/);
	await page.keyboard.press('Escape');
	await page.locator('.subagent-task-failures > button').click();
	await page.locator('.subagent-task-failures .subagent-task-row').click();
	await page.getByRole('button', { name: '准备重试', exact: true }).click();
	await page.keyboard.press('Escape');
	assert.match(await page.locator('.inputbar textarea').inputValue(), /调查任务 2/);
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:reveal-tool', { detail: { toolCallId: 'second' } })));
	await page.locator('.subagent-drawer').waitFor();
	assert.match(await page.locator('.subagent-drawer h2').innerText(), /调查任务 3/);
	await page.setViewportSize({ width: 390, height: 844 });
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	mkdirSync('tests/scratch', { recursive: true });
	await page.screenshot({ path: 'tests/scratch/subagent-task-legacy-mobile.png' });
	await page.keyboard.press('Escape');
	messages.push({ id: 'next-user', role: 'user', content: [{ type: 'text', text: '另一个问题' }] });
	addCall('third', [item(4)]);
	await page.reload();
	await page.locator('.subagent-task-group').nth(1).waitFor();
	assert.equal(await page.locator('.subagent-task-group').count(), 2, 'different user turns stay separate');
	assert.deepEqual(errors, []);
	console.log('PASS subagents legacy: same-turn aggregation, distinct tasks on same source, missing steps, failure retry, focus, tool jump, mobile and next-turn isolation');
} finally { await browser?.close(); await fixture.stop(); }
