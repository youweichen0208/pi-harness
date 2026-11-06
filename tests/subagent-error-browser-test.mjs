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
	messages.push(
		{ id: 'sources-call', role: 'assistant', model: 'test-model', content: [{ type: 'toolCall', id: 'sources', name: 'subagent', argumentsText: '{"action":"sources"}' }] },
		{ id: 'sources-result', role: 'toolResult', toolCallId: 'sources', toolName: 'subagent', durationMs: 25, content: [{ type: 'text', text: '{"sources":[{"name":"pi-web-ui"}]}' }] },
	);
	let base, displayed, liveRoute, detailMode = "error";
	await page.routeWebSocket(/\/ws(?:\?|$)/, route => {
		liveRoute = route;
		const upstream = route.connectToServer();
		route.onMessage(w => {
			const message = JSON.parse(String(w));
			if (message.type === 'subagent_request') {
				detailRequests.push(message);
				if (detailMode === "drop") return;
				if (detailMode === "stale" || detailMode === "complete") {
					const item = results.find(item => item.taskId === message.taskId);
					route.send(JSON.stringify({ type: "subagent_response", requestId: message.requestId, conversationId: message.conversationId, taskId: message.taskId, detail: { task: { ...item, phase: detailMode === "stale" ? "running" : item.status }, events: [{ seq: 0, at: stamp, type: "answer", text: "Retained execution output" }], truncated: false } }));
					return;
				}
				route.send(JSON.stringify({ type: 'subagent_response', requestId: message.requestId, conversationId: message.conversationId, taskId: message.taskId, error: 'fixture unavailable' }));
				return;
			}
			upstream.send(w);
		});
		upstream.onMessage(w => {
			const message = JSON.parse(String(w));
			if (message.type === 'snapshot' || message.type === 'snapshot_delta') {
				base = { ...base, ...message.state };
				displayed = { ...base, piConfigured: true, model: { id: "fixture-model", name: "Fixture model", provider: "fixture", vision: false }, isStreaming: false, messages, streamingMessage: null, taskProgress: null };
				route.send(JSON.stringify({ type: "snapshot", state: displayed }));
			} else route.send(w);
		});
	});
	await page.goto(`${fixture.base}/?token=${fixture.token}`);
	await page.locator('.subagent-task-group-head').waitFor();
	assert.equal(await page.locator('.subagent-task-group-head').getAttribute('aria-expanded'), 'true');
	assert.match(await page.locator('.subagent-task-counts .unsuccessful').innerText(), /未成功 2/);
	assert.match(await page.locator('.subagent-task-failures > button').innerText(), /任务已中止/);
	assert.doesNotMatch(await page.locator('.subagent-task-failures > button').innerText(), /超时/);
	assert.equal(await page.locator('.subagent-task-row').count(), 1, 'successful task stays visible');
	assert.equal(await page.locator('.msg-model').count(), 0);
	assert.equal(await page.locator('.header-model-label').count(), 0);
	const sourcesCard = page.locator('.toolcall-subagent-quiet').filter({ has: page.locator('.toolcall-action', { hasText: 'sources' }) });
	assert.equal(await sourcesCard.locator('.toolcall-head button').count(), 1, 'only the named expand control remains in the header');
	assert.match(await sourcesCard.locator('.toolcall-status').innerText(), /Completed/);
	assert.equal(await sourcesCard.locator('.toolcall-body').count(), 0);
	await sourcesCard.locator('.toolcall-name-toggle').click();
	assert.equal(await sourcesCard.locator('.subagent-tool-actions button').count(), 2, 'copy and zoom remain in details');
	await sourcesCard.locator('.subagent-tool-actions button').last().click();
	await page.locator('.toolcall-zoom').waitFor();
	await page.keyboard.press('Escape');
	await sourcesCard.locator('.toolcall-name-toggle').click();
	mkdirSync('tests/scratch', { recursive: true });
	for (const appearance of ['light', 'dark']) {
		await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance);
		await page.screenshot({ path: `tests/scratch/subagent-design-${appearance}.png` });
	}
	await page.evaluate(() => document.documentElement.dataset.appearance = 'light');
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
	// A terminal task still needs its first detail response. Drop it, then return stale status.
	detailMode = "drop";
	const beforeDrop = detailRequests.length;
	await page.locator('.subagent-task-row').filter({ hasText: '任务 3' }).click();
	await page.waitForTimeout(200);
	assert.equal(detailRequests.length, beforeDrop + 1);
	detailMode = "stale";
	await page.waitForTimeout(10800);
	assert(detailRequests.length >= beforeDrop + 2, 'lost terminal detail is automatically retried');
	assert.match(await page.locator('.subagent-drawer-meta').innerText(), /Completed/);
	assert.equal(await page.getByRole('button', { name: '停止任务', exact: true }).count(), 0);
	assert.match(await page.locator('.subagent-task-result').innerText(), /快照由统一入口生成/);
	await page.getByRole('button', { name: '执行过程', exact: true }).click();
	detailMode = "error";
	await page.locator('.subagent-drawer [role="status"]').waitFor();
	assert.equal(await page.getByRole('button', { name: '执行过程', exact: true }).getAttribute('aria-pressed'), 'true');
	assert.match(await page.locator('.subagent-drawer-content').innerText(), /子代理回答/);
	// Reconnect must wait for a full snapshot, then resume detail at the prior sequence.
	detailMode = "complete";
	const beforeReconnect = detailRequests.length;
	liveRoute.close();
	await page.waitForFunction(() => !document.querySelector('.subagent-drawer [role="status"]'));
	assert(detailRequests.length > beforeReconnect);
	assert.equal(detailRequests.at(-1).cursor, 1);
	await page.getByRole('button', { name: '结果', exact: true }).click();
	assert.match(await page.locator('.subagent-task-result').innerText(), /快照由统一入口生成/);
	const previousRequest = detailRequests.at(-1);
	liveRoute.send(JSON.stringify({ type: "snapshot", state: { ...displayed, sessionId: `${displayed.sessionId}-switched` } }));
	await page.waitForFunction(() => !document.querySelector('.subagent-drawer'));
	liveRoute.send(JSON.stringify({ ...previousRequest, type: "subagent_response", error: "late old-session response" }));
	await page.waitForTimeout(1200);
	assert.equal(await page.locator('.subagent-drawer').count(), 0, 'switching conversation closes detail and ignores old replies');
	detailMode = "error";
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
	await page.screenshot({ path: 'tests/scratch/subagent-design-mobile.png' });
	await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en'));
	await page.reload();
	await page.locator('.subagent-task-counts .unsuccessful').first().waitFor();
	assert.match(await page.locator('.subagent-task-counts .unsuccessful').first().innerText(), /3 unsuccessful/);
	assert.match(await page.locator('.subagent-task-all-failed').first().innerText(), /Task interrupted/);
	assert.deepEqual(errors, []);
	console.log('PASS current subagent failures, retry round-trip, raw native errors, terminal polling, tool reveal and mobile');
} finally { await browser?.close(); await fixture.stop(); }
