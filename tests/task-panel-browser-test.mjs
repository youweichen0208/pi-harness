/** Real UI with isolated snapshots; no model requests. Run after npm run build. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
import { deriveTaskProgress } from '../dist/server/task-progress.js';

const root = mkdtempSync(join(tmpdir(), 'pi-task-panel-'));
const user = { id: 'u', role: 'user', content: [{ type: 'text', text: 'Inspect files and run checks' }] };
const calls = (name, prefix, count) => Array.from({ length: count }, (_, i) => ({ type: 'toolCall', id: `${prefix}${i}`, name, argumentsText: JSON.stringify(name === 'read' ? { path: `file-${i}.ts` } : { command: `npm test -- check-${i}` }) }));
const readCalls = calls('read', 'read-', 7), commands = calls('bash', 'cmd-', 6);
const records = [user, { id: 'reads', role: 'assistant', content: readCalls }, ...readCalls.map(call => ({ id: `result-${call.id}`, role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'export const value = true;' }] })), { id: 'commands', role: 'assistant', content: commands }, ...commands.map(call => ({ id: `result-${call.id}`, role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'ok' }] }))];
for (let i = 0; i < 7; i++) writeFileSync(join(root, `file-${i}.ts`), 'export const value = true;\n');
let harness, browser;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_WEB_DATA_DIR: join(root, 'data') } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	mkdirSync('tests/scratch', { recursive: true });
	for (const [platform, width, lang, theme] of [['web', 1400, 'zh', 'warm'], ['darwin', 900, 'zh', 'graphite'], ['win32', 900, 'en', 'warm']]) {
		const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
		page.setDefaultTimeout(7000);
		const errors = [], sent = [];
		page.on('pageerror', error => errors.push(error.message));
		let socket, base, revision = 0, messages = [], running = false, taskOverride, projection, conversationId;
		const send = () => {
			const id = conversationId ?? base.conversationId;
			const task = taskOverride === null ? null : { ...deriveTaskProgress(id, messages, null, running), ...taskOverride };
			socket.send(JSON.stringify({ type: 'snapshot', state: { ...base, conversationId: id, rev: ++revision, messages, streamingMessage: null, isStreaming: running, piConfigured: true, taskProgress: task?.id ? task : null, codemode: projection } }));
		};
		await page.routeWebSocket('**/ws', route => {
			socket = route;
			const upstream = route.connectToServer();
			route.onMessage(raw => { const message = JSON.parse(String(raw)); sent.push(message); assert.notEqual(message.type, 'prompt', 'test must not call a model'); upstream.send(raw); });
			upstream.onMessage(raw => { const message = JSON.parse(String(raw)); if (message.type === 'snapshot') { base = message.state; revision = Math.max(revision, base.rev); send(); } else if (message.type !== 'snapshot_delta') route.send(raw); });
		});
		await page.addInitScript(({ platform, lang, theme }) => {
			if (platform !== 'web') window.electronAPI = { platform, windowAction() {}, onWindowState() { return () => {}; } };
			localStorage.setItem('pi-left-collapsed', 'true'); localStorage.setItem('pi-harness:lang', lang); localStorage.setItem('pi-harness:theme', theme);
			window.taskJumps = []; window.addEventListener('pi:jump-tool', event => window.taskJumps.push(event.detail));
		}, { platform, lang, theme });
		await page.goto(`http://127.0.0.1:${harness.port}`);
		await page.locator('textarea:not([disabled])').first().waitFor();
		// Narrow layouts expose the sidebar through the existing task entry once running.
		messages = width < 1000 ? records : [user]; running = true; send();
		if (width < 1000) await page.locator('.header-task-progress').click();
		else await page.getByRole('tab', { name: lang === 'zh' ? '任务' : 'Tasks', exact: true }).click();
		const panel = page.locator('.task-progress:visible');
		messages = [user]; send();
		await panel.locator('.task-overview-state').filter({ hasText: 'Running' }).waitFor();
		await panel.getByText(lang === 'zh' ? '正在处理请求，尚无执行步骤。' : 'Processing the request. No execution steps yet.', { exact: true }).waitFor();
		assert.equal(await panel.locator('.task-step, .task-plan-step').count(), 0);
		running = false; messages = []; send();
		await panel.locator('.task-panel-empty').waitFor();
		assert.equal(await panel.locator('.task-section').count(), 0);
		await page.screenshot({ path: `tests/scratch/task-panel-empty-${platform}.png` });
		messages = [user, { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }]; send();
		await panel.locator('.task-panel-empty').waitFor();
		messages = records; send();
		await panel.locator('.task-overview-state').filter({ hasText: 'Completed' }).waitFor();
		assert.equal(await panel.locator('.task-overview h3').innerText(), 'Inspect files and run checks');
		const readPhase = panel.locator('.task-step').first();
		await readPhase.locator('.task-step-toggle').click();
		assert.equal(await readPhase.locator('.task-step-items > li:not(.task-step-more)').count(), 4);
		await readPhase.locator('.task-step-more button').click();
		assert.equal(await readPhase.locator('.task-step-items > li:not(.task-step-more)').count(), 7);
		send();
		assert.equal(await readPhase.locator('.task-step-more button').getAttribute('aria-expanded'), 'true');
		const taskTab = page.getByRole('tab', { name: lang === 'zh' ? '任务' : 'Tasks', exact: true });
		await taskTab.focus(); await page.keyboard.press('Home'); await page.keyboard.press('End');
		assert.equal(await taskTab.getAttribute('aria-selected'), 'true');
		assert.equal(await readPhase.locator('.task-step-more button').getAttribute('aria-expanded'), 'true');
		await readPhase.getByRole('button', { name: 'file-6.ts', exact: true }).click();
		await page.waitForFunction(() => !!document.querySelector('.fp-embedded'));
		assert(sent.some(message => JSON.stringify(message).includes('file-6.ts')), 'preview requested the expanded record');
		await page.locator('.fp-back').click();
		// Return to the task drawer if opening a file dismissed it.
		if (!(await panel.isVisible())) await page.locator('.header-task-progress').click();
		await readPhase.locator('.task-step-more button').click();
		assert.equal(await readPhase.locator('.task-step-items > li:not(.task-step-more)').count(), 4);
		const commandPhase = panel.locator('.task-step').last();
		await commandPhase.locator('.task-step-toggle').click(); await commandPhase.locator('.task-step-more button').click();
		await commandPhase.locator('.task-step-items > li:not(.task-step-more) button').last().click();
		assert.equal((await page.evaluate(() => window.taskJumps)).at(-1).toolCallId, 'cmd-5');
		if (!(await panel.isVisible())) await page.locator('.header-task-progress').click();
		// Same plan identity, different request: do not inherit expanded details.
		taskOverride = { sourceMessageId: 'u2', title: 'Next request' }; send();
		await panel.locator('.task-overview h3').filter({ hasText: 'Next request' }).waitFor();
		assert.equal(await panel.locator('.task-step-items').count(), 0);
		await panel.locator('.task-step-toggle').first().click();
		conversationId = `${base.conversationId}-other`; taskOverride = { title: 'Other conversation' }; send();
		await panel.locator('.task-overview h3').filter({ hasText: 'Other conversation' }).waitFor();
		assert.equal(await panel.locator('.task-step-items').count(), 0, 'conversation switch resets details even with reused tool IDs');
		conversationId = undefined;
		taskOverride = { title: 'A long task title that wraps in the sidebar without hiding the current status or causing horizontal overflow. 检查任务状态与执行结果。', status: 'waiting', plan: { source: 'plan', origin: 'p', status: 'active', revision: 1, added: 0, removed: 1, awaitingConfirmation: true, items: [{ id: 'one', title: 'Read files', status: 'done' }, { id: 'two', title: 'Validate results', status: 'pending' }, { id: 'removed', title: 'Removed step', status: 'removed' }] } }; send();
		await panel.locator('.task-overview-state').filter({ hasText: 'Waiting' }).waitFor();
		assert.match(await panel.locator('.task-overview-meta').innerText(), /1\/2/);
		assert.equal(await panel.locator('.task-plan-step.running').count(), 0);
		await page.screenshot({ path: `tests/scratch/task-panel-waiting-${platform}.png` });
		assert(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
		for (const [status, label] of [['running', 'Running'], ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['done', 'Completed']]) {
			taskOverride = { status }; running = status === 'running'; send(); await panel.locator('.task-overview-state').filter({ hasText: label }).waitFor();
		}
		messages = [...records, { id: 'limited', role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'Partial response' }] }]; taskOverride = undefined; send();
		await panel.locator('.task-overview-state').filter({ hasText: 'Failed' }).waitFor();
		assert((await panel.locator('.task-overview-reason').innerText()).length > 0);
		// Offline status is not completion. Reconnect uses the authoritative snapshot.
		messages = records; running = true; send();
		await panel.locator('.task-overview-state').filter({ hasText: 'Running' }).waitFor();
		await socket.close({ code: 1000, reason: 'task panel regression' });
		assert.equal(await panel.locator('.task-overview-state').innerText(), 'Running');
		running = false;
		await panel.locator('.task-overview-state').filter({ hasText: 'Completed' }).waitFor();
		// A retained Codemode record without taskProgress must not imply global success.
		taskOverride = null;
		projection = { history: [user, { id: 'cm-a', role: 'assistant', content: [{ type: 'toolCall', id: 'cm', name: 'codemode', argumentsText: '{"code":"return 1"}' }] }, { id: 'cm-r', role: 'toolResult', toolCallId: 'cm', toolName: 'codemode', content: [], codemode: { calls: [], totalCalls: 0 } }], live: [] }; send();
		await panel.locator('.cm-record-group').waitFor();
		assert.equal(await panel.locator('.task-overview-state').count(), 0);
		assert.equal(await panel.locator('.task-overview h3').innerText(), lang === 'zh' ? '本轮执行记录' : 'Execution records for this request');
		assert.deepEqual(errors, []);
		await page.close();
	}
	console.log('PASS task sidebar: empty/running states, overview, authoritative outcomes, full records, preview/jumps, request isolation, keyboard tabs, reconnect and Codemode-only history (Web/macOS/Windows shells)');
} finally { await browser?.close(); await harness?.stop(); rmSync(root, { recursive: true, force: true }); }
