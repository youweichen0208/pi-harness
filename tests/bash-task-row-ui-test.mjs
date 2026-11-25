// bash_task 是后台命令的 list/read/stop 控制，本质仍是命令运行：
// 它必须与 bash 同组渲染成「运行了命令」里的命令行（`bash_task list`），
// 不再落回带「参数/输出」的通用工具卡片。Model-free, deterministic fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';
const port = 9418;
assert.equal(await portUp(port), false, `Port ${port} busy`);
const root = mkdtempSync(join(tmpdir(), 'pi-bash-task-row-'));
const cwd = join(root, 'workspace'); mkdirSync(cwd);
writeFileSync(join(cwd, 'README.md'), '# bash_task row review\n');
const time = Date.now();
const bash = (id, command) => ({ type: 'toolCall', id, name: 'bash', argumentsText: JSON.stringify({ command }) });
const task = (id, args) => ({ type: 'toolCall', id, name: 'bash_task', argumentsText: JSON.stringify(args) });
const result = (call, text = 'ok\n') => ({ id: `r-${call.id}`, role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: false, details: { exitCode: 0 }, content: [{ type: 'text', text }] });
const assistant = (id, ...content) => ({ id, role: 'assistant', timestamp: time, content });
const user = (id, text) => ({ id, role: 'user', timestamp: time, content: [{ type: 'text', text }] });
const listCall = task('t0', { action: 'list' });
const listOutput = JSON.stringify([{ id: 'toolu_x', state: 'done' }], null, 2);
let server, browser;
const attach = async (page) => {
	let socket, base, fixture = null;
	await page.routeWebSocket('**/ws', route => {
		socket = route; const upstream = route.connectToServer();
		route.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (['prompt', 'abort', 'recall_queue'].includes(message.type)) {
				if (message.type === 'prompt') route.send(JSON.stringify({ type: 'prompt_result', requestId: message.requestId, conversationId: base.state.conversationId, ok: true }));
				return;
			}
			upstream.send(wire);
		});
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'snapshot') {
				base = message;
				message.state.piConfigured = true;
				if (fixture) Object.assign(message.state, fixture);
			}
			if (message.type !== 'snapshot_delta') route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://localhost:${port}`);
	await page.locator('.inputbox textarea').first().waitFor();
	for (let i = 0; i < 100 && !base; i++) await sleep(100);
	assert(base, 'initial snapshot captured');
	const send = async (messages, extra = {}) => {
		fixture = { messages, isStreaming: false, streamingMessage: null, ...extra };
		const snap = structuredClone(base);
		Object.assign(snap.state, fixture);
		snap.state.rev += 1;
		socket.send(JSON.stringify(snap));
	};
	return { send };
};
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = ''; server.stderr.on('data', d => log += d); server.stdout.on('data', d => log += d);
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	assert(await portUp(port), log);
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	const page = await context.newPage(); page.setDefaultTimeout(10000);
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	const { send } = await attach(page);

	// A) bash + bash_task 混合：收起为一行「运行了命令」，没有通用工具卡片。
	const run = bash('b0', 'echo hi');
	await send([user('u-mix', '看看后台'), assistant('a-b0', run), result(run), assistant('a-t0', listCall), result(listCall, listOutput)]);
	const summary = page.locator('.process-group-summary-line').first();
	await summary.waitFor();
	assert.match(await summary.innerText(), /运行了命令/);
	assert.equal(await page.locator('.toolcall').count(), 0, 'bash_task no longer renders a generic tool card');
	assert.equal(await page.locator('.toolcall-parameters').count(), 0, 'no 参数 section for bash_task');

	// B) 展开后 bash_task 是同款命令行：终端图标 + `bash_task list` 摘要。
	await summary.click();
	await page.locator('[data-tool-call-id="t0"].bash-row.ok').waitFor();
	assert.equal(await page.locator('.bash-row.ok').count(), 2, 'bash and bash_task share one command list');
	assert.equal(await page.locator('[data-tool-call-id="t0"] .bash-row-subtitle').textContent(), 'bash_task list');
	assert.equal(await page.locator('[data-tool-call-id="t0"] .bash-row-icon').count(), 1);

	// C) 点击行展开 Shell 卡：命令与原始输出都在，复制取展示的命令行。
	await page.locator('[data-tool-call-id="t0"] .bash-row-head').click();
	await page.locator('[data-tool-call-id="t0"] .bash-request-code').waitFor();
	assert.match(await page.locator('[data-tool-call-id="t0"] .bash-request-code').textContent(), /bash_task list/);
	assert.match(await page.locator('[data-tool-call-id="t0"] .bash-response-card').innerText(), /toolu_x/);

	// D) read/stop 带 id 的调用摘要包含动作与目标。
	const readCall = task('t1', { action: 'read', id: 'toolu_x', cursor: 12 });
	const stopCall = task('t2', { action: 'stop', id: 'toolu_x' });
	await send([user('u-rs', '读取并停止'), assistant('a-t1', readCall), result(readCall, 'output\n'), assistant('a-t2', stopCall), result(stopCall, 'stopped\n')]);
	await page.locator('.process-group-summary-line').first().click();
	await page.locator('[data-tool-call-id="t1"].bash-row.ok').waitFor();
	assert.equal(await page.locator('[data-tool-call-id="t1"] .bash-row-subtitle').textContent(), 'bash_task read toolu_x --cursor 12');
	assert.equal(await page.locator('[data-tool-call-id="t2"] .bash-row-subtitle').textContent(), 'bash_task stop toolu_x');

	// E) 单条 bash_task：无组头，行本身带终端图标（single-command 形态）。
	await send([user('u-single', '单独查看'), assistant('a-single', listCall), result(listCall, listOutput)]);
	await page.locator('.single-command .bash-row.ok').first().waitFor();
	assert.equal(await page.locator('.process-group-head').count(), 0);
	assert.equal(await page.locator('.process-group-summary-line').count(), 0);
	assert.equal(await page.locator('.single-command .bash-row-subtitle').textContent(), 'bash_task list');

	// F) pi:reveal-tool 定位 bash_task 行仍然有效。
	await send([user('u-reveal', '定位'), assistant('a-b0', run), result(run), assistant('a-t0', listCall), result(listCall, listOutput)]);
	await page.locator('.process-group-summary-line').first().waitFor();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:reveal-tool', { detail: { toolCallId: 't0' } })));
	await page.locator('[data-tool-call-id="t0"] .bash-row-body').waitFor();

	assert.deepEqual(errors, []);
	console.log('PASS bash_task row: merged command list, no generic card, list/read/stop labels, single row, reveal');
} finally {
	await browser?.close().catch(() => {});
	server?.kill('SIGTERM');
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}