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
	const errors = [], detailRequests = [];
	page.on('pageerror', error => errors.push(error.message));
	const stamp = Date.now();
	const tasks = ['调查快照推送实现', '核对数据流与缓存结构', '检查发布脚本'];
	const args = JSON.stringify({ action: 'run', question: 'Why?', tasks: tasks.map((task, i) => ({ title: `任务 ${i + 1}`, sourceId: `repo:${i}`, task })) });
	const results = tasks.map((task, i) => ({
		taskId: `00000000-0000-4000-8000-00000000000${i}`,
		sourceId: `repo:${i}`, source: `项目 ${i + 1}`, root: fixture.root, title: `任务 ${i + 1}`,
		task: `Why?\n\n${task}`, status: i < 2 ? 'cancelled' : 'completed',
		text: i < 2 ? 'Error: This operation was aborted' : '成功报告', evidenceStatus: i < 2 ? 'unverified' : 'checked',
		durationMs: 1000, steps: [],
		...(i === 2 ? { report: { summary: '快照由统一入口生成。', findings: [{ kind: 'implementation', statement: '快照按节流间隔推送。', citations: [{ path: 'agent-service.ts', startLine: 1, endLine: 1, excerpt: 'const interval = 60;' }] }], connections: [], openQuestions: [], checkedAt: new Date().toISOString() } } : {}),
	}));
	const messages = [
		{ id: 'u', role: 'user', content: [{ type: 'text', text: '调查快照与缓存' }], timestamp: stamp },
		{ id: 'a', role: 'assistant', model: 'test-model', timestamp: stamp + 1, content: [{ type: 'toolCall', id: 'sub', name: 'subagent', argumentsText: args }] },
		{ id: 'result', role: 'toolResult', toolCallId: 'sub', toolName: 'subagent', durationMs: 3200, timestamp: stamp + 2, content: [{ type: 'text', text: JSON.stringify({ results }) }] },
	];
	let base;
	await page.routeWebSocket(/\/ws(?:\?|$)/, route => {
		const upstream = route.connectToServer();
		route.onMessage(w => {
			const message = JSON.parse(String(w));
			if (message.type === 'subagent_request') {
				detailRequests.push(message);
				route.send(JSON.stringify({ type: 'subagent_response', requestId: message.requestId, conversationId: message.conversationId, taskId: message.taskId, error: 'fixture unavailable' }));
				return;
			}
			upstream.send(w);
		});
		upstream.onMessage(w => {
			const message = JSON.parse(String(w));
			if (message.type === 'snapshot' || message.type === 'snapshot_delta') {
				base = { ...base, ...message.state };
				route.send(JSON.stringify({ type: 'snapshot', state: { ...base, piConfigured: true, isStreaming: false, messages, streamingMessage: null, taskProgress: null } }));
			} else route.send(w);
		});
	});
	await page.goto(`${fixture.base}/?token=${fixture.token}`);
	await page.locator('.subagent-task-group-head').click();
	assert.equal(await page.locator('.subagent-task-row').count(), 1, 'successful task stays visible');
	await page.locator('.subagent-task-failures > button').click();
	assert.equal(await page.locator('.subagent-task-failures .subagent-task-row').count(), 2);
	assert.match(await page.locator('.subagent-task-failures').innerText(), /任务已中止/);
	const input = page.locator('.inputbar textarea');
	await input.fill('已有草稿');
	await page.locator('.subagent-task-failures .subagent-task-row').first().click();
	await page.locator('.subagent-drawer [role="status"]').waitFor();
	await page.waitForTimeout(1300);
	assert.equal(detailRequests.length, 1, 'terminal detail errors do not keep polling');
	await page.getByRole('button', { name: '重试', exact: true }).click();
	await page.waitForTimeout(1300);
	assert.equal(detailRequests.length, 2, 'manual retry forces one new request without restarting the timer');
	await page.getByRole('button', { name: '执行过程', exact: true }).click();
	assert.match(await page.locator('.subagent-drawer-content').innerText(), /未完成：没有成功执行调查步骤/);
	assert(!/此记录未保存执行步骤/.test(await page.locator('.subagent-drawer-content').innerText()));
	await page.getByRole('button', { name: '结果', exact: true }).click();
	await page.getByRole('button', { name: '准备重试', exact: true }).click();
	const draft = await input.inputValue();
	assert(draft.startsWith('已有草稿'));
	assert(draft.includes('"scope": "selected"'));
	assert(draft.includes('repo:0') && !draft.includes('repo:1'));
	assert.equal(draft.match(/Why\?/g)?.length, 1, 'retry does not inject the original question twice');
	assert(draft.includes('"task": "调查快照推送实现"'));
	await page.keyboard.press('Escape');
	mkdirSync('tests/scratch', { recursive: true });
	await page.screenshot({ path: 'tests/scratch/subagent-errors-light.png' });
	for (const item of results) { item.status = 'cancelled'; item.text = 'Error: This operation was aborted'; item.evidenceStatus = 'unverified'; delete item.report; }
	messages[2].content[0].text = JSON.stringify({ results });
	await page.reload();
	await page.locator('.subagent-task-all-failed').waitFor();
	assert.match(await page.locator('.subagent-task-all-failed').innerText(), /均未成功完成/);
	assert.equal(await page.locator('.subagent-task-group-head').getAttribute('aria-expanded'), 'false');
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:reveal-tool', { detail: { toolCallId: 'sub' } })));
	await page.locator('.subagent-drawer').waitFor();
	await page.keyboard.press('Escape');
	assert.equal(await page.locator('.subagent-task-failures > button').getAttribute('aria-expanded'), 'true', 'tool navigation expands failed tasks');
	assert.equal(await page.locator('.subagent-task-failures .subagent-task-row').count(), 3);
	messages.push(
		{ id: 'native-user', role: 'user', content: [{ type: 'text', text: '另一个问题' }] },
		{ id: 'native-assistant', role: 'assistant', content: [{ type: 'toolCall', id: 'native', name: 'subagent', argumentsText: JSON.stringify({ action: 'run', tasks: [{ sourceId: 'repo:native', task: 'Investigate' }] }) }] },
		{ id: 'native-result', role: 'toolResult', toolCallId: 'native', toolName: 'subagent', isError: true, content: [{ type: 'text', text: 'Error: native admission failed' }] },
	);
	await page.reload();
	const native = page.locator('[data-tool-call-id="native"]');
	await native.locator('.structured-tool-output pre').waitFor();
	assert.match(await native.locator('.structured-tool-output pre').textContent(), /native admission failed/);
	assert.equal(await native.locator('.subagent-task-row').count(), 0, 'invalid final output never becomes queued tasks');
	assert.match(await native.locator('.toolcall-args').textContent(), /Investigate/);
	await page.setViewportSize({ width: 390, height: 844 });
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	assert.deepEqual(errors, []);
	console.log('PASS current subagent failures, retry round-trip, raw native errors, terminal polling, tool reveal and mobile');
} finally { await browser?.close(); await fixture.stop(); }
