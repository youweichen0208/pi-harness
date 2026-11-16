/** Browser task UI with deterministic wire data; native execution is covered separately. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, _electron as electron } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'omp-task-ui-'))), root = join(base, 'workspace'), data = join(base, 'data'), agent = join(data, 'omp/agent');
mkdirSync(root);
mkdirSync(agent, { recursive: true });
writeFileSync(join(root, 'note.md'), '# Task fixture\n\nWiki content.\n');
writeFileSync(join(root, 'other.md'), '# Other document\n');
writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'fixture' }] } } }));
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false } }));
let harness, browser, app, page, baseUrl;
try {
	if (process.argv[2]) {
		app = await electron.launch({ executablePath: resolve(process.argv[2]), args: [`--user-data-dir=${join(base, 'profile')}`], env: testEnv({ PI_WEB_DATA_DIR: data, PI_WEB_CWD: root }) });
		for (let i = 0; i < 200; i++) { page = app.windows().find(item => item.url().startsWith('http://127.0.0.1:')); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)); }
		assert(page, 'packaged main window ready'); baseUrl = new URL(page.url()).origin;
		await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.setContentSize(1440, 1000); });
		await page.setViewportSize({ width: 1440, height: 1000 });
	} else {
		harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: data, PI_WEB_CWD: root } });
		browser = await chromium.launch({ executablePath: CHROME_PATH });
		page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		baseUrl = `http://127.0.0.1:${harness.port}`;
	}
	page.setDefaultTimeout(10000);
	const errors = [], requests = [], prematureWiki = []; let displayed, liveRoute, delayDetails = false, handshakeSent = false;
	page.on('pageerror', error => errors.push(error.message));
	page.on('request', request => { if (request.url().endsWith('/api/wiki') && !handshakeSent) prematureWiki.push(request.postDataJSON()?.action); });
	const tasks = [{ id: 'child-one', parentToolCallId: 'spawn', agent: 'task', title: '检查原生任务', task: 'Read the fixture.', status: 'running', canStop: true, tokens: 42 }, { id: 'child-two', parentToolCallId: 'spawn', agent: 'task', title: '已完成的任务', status: 'completed', canStop: false }];
	await (app ? app.context() : page).routeWebSocket(/\/ws(?:\?|$)/, route => {
		handshakeSent = false;
		let routeState;
		liveRoute = route; const upstream = route.connectToServer();
		route.onMessage(raw => {
			const request = JSON.parse(String(raw));
			if (request.type !== 'omp_task_request') { upstream.send(raw); return; }
			requests.push(request);
			if (request.action === 'detail' && delayDetails) return;
			const task = tasks.find(item => item.id === request.taskId);
			if (request.action === 'stop') {
				task.status = 'aborted'; task.canStop = false;
				route.send(JSON.stringify({ ...request, type: 'omp_task_response', task, cancelled: true }));
				routeState = { ...routeState, rev: routeState.rev + 1, ompTasks: tasks }; if (liveRoute === route) displayed = routeState;
				route.send(JSON.stringify({ type: 'snapshot', state: routeState })); return;
			}
			route.send(JSON.stringify({ ...request, type: 'omp_task_response', task, messages: request.cursor === 0 ? [{ id: 'step-one', role: 'toolResult', content: [{ type: 'text', text: 'Actual tool output' }] }, { id: 'answer-one', role: 'assistant', content: [{ type: 'text', text: 'Native child answer' }] }] : [{ id: 'answer-two', role: 'assistant', content: [{ type: 'text', text: 'More native task records' }] }], nextCursor: 3, hasMore: request.cursor === 0, truncated: request.cursor !== 0 }));
		});
		upstream.onMessage(raw => {
			const message = JSON.parse(String(raw));
			if (message.type === 'ready') { setTimeout(() => { handshakeSent = true; route.send(raw); }, 200); return; }
			if (message.type === 'snapshot' || message.type === 'snapshot_delta') {
				routeState = { ...routeState, ...message.state, piConfigured: true, messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'Delegate work' }] }, { id: 'a', role: 'assistant', content: [{ type: 'toolCall', id: 'spawn', name: 'task', argumentsText: '{"tasks":[]}' }, { type: 'toolCall', id: 'unrelated', name: 'task', argumentsText: '{"tasks":[]}' }] }], streamingMessage: null, isStreaming: false, ompTasks: tasks };
				if (liveRoute === route) displayed = routeState;
				route.send(JSON.stringify({ type: 'snapshot', state: routeState }));
			} else route.send(raw);
		});
	});
	await page.goto(baseUrl);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached', timeout: 40000 });
	await page.getByRole('tab', { name: '任务', exact: true }).click();
	const opener = page.locator('.panel-lower').getByRole('button', { name: /检查原生任务/ }); await opener.click();
	let dialog = page.getByRole('dialog', { name: '检查原生任务' }); await dialog.waitFor();
	await dialog.getByText('Actual tool output', { exact: true }).waitFor();
	await dialog.getByRole('button', { name: '加载更多记录' }).click();
	await dialog.getByText('More native task records').waitFor();
	assert(requests.some(request => request.action === 'detail' && request.cursor === 3));
	await dialog.getByRole('button', { name: '结果', exact: true }).click();
	assert.equal(await dialog.getByText('Actual tool output').count(), 0);
	await dialog.getByText('Native child answer').waitFor();
	await dialog.getByRole('button', { name: '停止任务' }).click();
	await dialog.getByText('已取消', { exact: true }).waitFor();
	assert.equal(requests.filter(request => request.action === 'stop').length, 1);
	assert.equal(tasks[1].status, 'completed');
	for (const appearance of ['light', 'dark']) {
		await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance);
		mkdirSync('tests/scratch', { recursive: true }); await page.screenshot({ path: `tests/scratch/omp-task-${appearance}.png` });
	}
	await page.setViewportSize({ width: 390, height: 844 });
	assert(await dialog.evaluate(element => element.getBoundingClientRect().width <= innerWidth));
	await page.keyboard.press('Tab'); assert(await dialog.evaluate(element => element.contains(document.activeElement)));
	await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0);
	await page.setViewportSize({ width: 1440, height: 1000 }); await opener.click();
	const oldRequests = requests.length;
	await dialog.getByRole('button', { name: '关闭', exact: true }).click();
	await new Promise(resolve => setTimeout(resolve, 2200)); assert.equal(requests.length, oldRequests, 'closed drawer releases polling');
	const toolCard = page.locator('.omp-task-call'); assert.equal(await toolCard.count(), 1, 'only matching parent task call gains child links');
	await toolCard.getByRole('button', { name: /检查原生任务/ }).click(); await dialog.waitFor();
	await page.keyboard.press('Escape');
	assert(await toolCard.getByRole('button', { name: /检查原生任务/ }).evaluate(element => element === document.activeElement), 'tool-card opener regains focus');

	// The browser adapter creates a real second Document. Electron coverage uses the same DOM adoption path.
	if (!app) await page.addInitScript(() => { window.electronAPI = { platform: 'linux', windowAction() {}, onWindowState() { return () => {}; }, assistantVisibility: async () => {} }; });
	tasks[0].status = 'running'; tasks[0].canStop = true;
	const wikiUrl = `${baseUrl}/?${new URLSearchParams({ 'wiki-window': '1', cwd: root, doc: 'note.md', client: 'omp-task-wiki' })}`;
	if (app) {
		const opened = app.waitForEvent('window');
		await page.evaluate(url => window.open(url, 'omp-test-wiki'), wikiUrl);
		page = await opened; page.setDefaultTimeout(10000);
		page.on('pageerror', error => errors.push(error.message));
		page.on('request', request => { if (request.url().endsWith('/api/wiki') && !handshakeSent) prematureWiki.push(request.postDataJSON()?.action); });
		dialog = page.getByRole('dialog', { name: '检查原生任务' });
	} else await page.goto(wikiUrl);
	await page.locator('.wiki-prose .fp-rich-document').waitFor({ timeout: 40000 });
	const popupWait = app ? app.waitForEvent('window') : page.waitForEvent('popup');
	await page.locator('.wiki-ask-toggle').click();
	const popup = await popupWait; popup.on('pageerror', error => errors.push(error.message));
	await popup.locator('.wiki-assistant').waitFor();
	await popup.locator('.wiki-assistant-tasks > summary').click();
	const wikiOpener = popup.locator('.wiki-assistant-tasks').getByRole('button', { name: /检查原生任务/ });
	await wikiOpener.click();
	const floatingDialog = popup.getByRole('dialog', { name: '检查原生任务' }); await floatingDialog.waitFor();
	assert.equal(await page.locator('.subagent-drawer').count(), 0, 'task drawer belongs to the floating assistant document');
	await floatingDialog.getByText('Actual tool output', { exact: true }).waitFor();
	for (let i = 0; i < 12; i++) { await popup.keyboard.press('Tab'); assert(await floatingDialog.evaluate(element => element.contains(document.activeElement))); }
	await popup.keyboard.press('Escape'); assert.equal(await floatingDialog.count(), 0);
	assert(await popup.locator('.wiki-assistant').isVisible(), 'Escape closes only the drawer');
	assert(await wikiOpener.evaluate(element => element === document.activeElement));
	await popup.locator('.omp-task-call').getByRole('button', { name: /检查原生任务/ }).click(); await floatingDialog.waitFor();
	await floatingDialog.getByText('Native child answer').waitFor();
	await popup.screenshot({ path: 'tests/scratch/omp-task-wiki-floating.png' });
	delayDetails = true;
	await floatingDialog.getByRole('button', { name: '关闭', exact: true }).click();
	await wikiOpener.click(); await floatingDialog.waitFor();
	await popup.getByRole('button', { name: '固定到右侧', exact: true }).evaluate(button => button.click());
	await page.locator('.wiki-assistant.is-docked').waitFor();
	assert.equal(await popup.locator('.subagent-drawer').count(), 0, 'docking closes the old-document drawer');
	assert.equal(await page.locator('.subagent-drawer').count(), 0);
	const late = requests.at(-1);
	liveRoute.send(JSON.stringify({ ...late, type: 'omp_task_response', messages: [{ id: 'late', role: 'assistant', content: [{ type: 'text', text: 'STALE_TASK_RESPONSE' }] }], nextCursor: 1 }));
	assert.equal(await page.getByText('STALE_TASK_RESPONSE').count(), 0);
	delayDetails = false;
	const dockedOpener = page.locator('.wiki-assistant-tasks').getByRole('button', { name: /检查原生任务/ });
	await dockedOpener.click(); await dialog.waitFor();
	await dialog.getByRole('button', { name: '停止任务' }).click();
	await dialog.getByText('已取消', { exact: true }).waitFor();
	assert.equal(requests.at(-1).conversationId, displayed.conversationId, 'Wiki actions keep the document conversation owner');
	await page.keyboard.press('Escape');
	await page.locator('.omp-task-call').getByRole('button', { name: /检查原生任务/ }).click(); await dialog.waitFor();
	await page.getByRole('button', { name: '收起对话面板', exact: true }).evaluate(button => button.click());
	await dialog.waitFor({ state: 'detached' });
	const closedCount = requests.length;
	await new Promise(resolve => setTimeout(resolve, 2200)); assert.equal(requests.length, closedCount, 'closing Wiki chat removes tool-card detail polling');
	await page.locator('.wiki-ask-toggle').click();
	await page.locator('.omp-task-call').getByRole('button', { name: /检查原生任务/ }).click(); await dialog.waitFor();
	const previousConversation = displayed.conversationId;
	await page.locator('.wiki-tree-main[title="other.md"]').evaluate(button => button.click());
	await page.waitForFunction(() => new URL(location.href).searchParams.get('doc') === 'other.md', null, { timeout: 40000 });
	await dialog.waitFor({ state: 'detached' });
	assert.notEqual(displayed.conversationId, previousConversation);
	await page.locator('.omp-task-call').getByRole('button', { name: /检查原生任务/ }).click(); await dialog.waitFor();
	assert.equal(requests.at(-1).conversationId, displayed.conversationId, 'switching documents uses the new owner even if a fixture reuses its task id');
	await page.keyboard.press('Escape');
	assert.deepEqual(errors, []); assert.deepEqual(prematureWiki, [], 'provisional snapshots do not admit Wiki HTTP before ready'); assert(liveRoute);
	console.log('PASS task browser UI: task panel and matching tool cards, Wiki floating/docked windows, detail pages, stop ownership, focus, late responses and cleanup');
} catch (error) { console.error(error); console.error(harness?.logs); console.error(await page?.locator("body").innerText()); await page?.screenshot({ path: "/tmp/omp-task-entry-failure.png", timeout: 3000 }).catch(() => {}); throw error; } finally { await browser?.close(); if (app) { await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); }).catch(() => {}); await app.close(); } await harness?.stop(); rmSync(base, { recursive: true, force: true }); }
