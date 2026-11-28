// 展开的 Shell 卡落在命令标签正下方，不与命令行同层（ui-design 4.2）：
// 多行组与单命令组的 .bash-row-body 都缩进 26px（图标列 15–16px + 间距 10px），
// 卡片左缘与命令文字左缘对齐（±2px）。Model-free, deterministic fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp, freePort } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';
const port = 9433;
assert.equal(await portUp(port), false, `Port ${port} busy`);
const root = mkdtempSync(join(tmpdir(), 'pi-shell-indent-'));
const cwd = join(root, 'workspace'); mkdirSync(cwd);
writeFileSync(join(cwd, 'README.md'), '# shell card indent\n');
const time = Date.now();
const bash = (id, command) => ({ type: 'toolCall', id, name: 'bash', argumentsText: JSON.stringify({ command }) });
const result = (call, text = 'ok\n') => ({ id: `r-${call.id}`, role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: false, details: { exitCode: 0 }, content: [{ type: 'text', text }] });
const assistant = (id, ...content) => ({ id, role: 'assistant', timestamp: time, content });
const user = (id, text) => ({ id, role: 'user', timestamp: time, content: [{ type: 'text', text }] });
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
/** Geometry of the first expanded row: body indent and card vs label alignment. */
const geometry = async (page) => page.evaluate(() => {
	const row = document.querySelector('.process-group .bash-row');
	const head = row.querySelector('.bash-row-head');
	const body = row.querySelector('.bash-row-body');
	const label = row.querySelector('.bash-row-subtitle');
	const card = body.querySelector('.bash-shell-card');

	return {
		paddingLeft: getComputedStyle(body).paddingLeft,
		bodyVsHead: body.getBoundingClientRect().left - head.getBoundingClientRect().left,
		cardVsHead: card.getBoundingClientRect().left - head.getBoundingClientRect().left,
		cardVsLabel: card.getBoundingClientRect().left - label.getBoundingClientRect().left,
		headPaddingLeft: getComputedStyle(head).paddingLeft,
		headGap: getComputedStyle(head).gap,
	};
});
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

	// A) 多行命令组：收起为一行，点开后展开首行 → Shell 卡缩进到命令标签下。
	const c1 = bash('b1', 'echo one'), c2 = bash('b2', 'echo two'), c3 = bash('b3', 'echo three');
	await send([user('u-multi', '跑几条命令'), assistant('a-multi', c1, c2, c3), result(c1), result(c2), result(c3)]);
	await page.locator('.process-group-summary-line').first().click();
	await page.locator('.process-group.open .bash-row-head').first().waitFor();
	// 层级：行列表缩进在组头之下，挂在 1px 左竖引导线右侧（ui-design 4.2）。
	const group = await page.evaluate(() => {
		const head = document.querySelector('.process-group.open .process-group-head');
		const rows = document.querySelector('.process-group.open .process-group-rows');
		const state = document.querySelector('.process-group.open .bash-row.ok .bash-state');
		const text = document.querySelector('.process-group.open .bash-row.ok .bash-row-subtitle');
		const rowsBox = rows.getBoundingClientRect();
		return {
			borderLeftWidth: getComputedStyle(rows).borderLeftWidth,
			rowsVsHead: rowsBox.left - head.getBoundingClientRect().left,
			stateDisplay: getComputedStyle(state).display,
			lineToText: Math.round(text.getBoundingClientRect().left - (rowsBox.left + 1)),
		};
	});
	assert.equal(group.borderLeftWidth, '1px', 'expanded list hangs on a left guide line');
	assert(group.rowsVsHead >= 8 && group.rowsVsHead <= 12, `rows indent under the header (got ${group.rowsVsHead})`);
	assert.equal(group.stateDisplay, 'none', 'expanded group children drop the repeated terminal icon');
	assert(group.lineToText >= 8 && group.lineToText <= 16, `guide line to command text gap (got ${group.lineToText})`);
	await page.locator('.process-group.open .bash-row-head').first().click();
	await page.locator('.process-group.open .bash-row .bash-row-body .bash-shell-card').first().waitFor();
	const multi = await geometry(page);
	assert.equal(multi.paddingLeft, '7px', 'iconless multi-row group body padding-left');
	assert.equal(multi.bodyVsHead, 0, 'body block itself stays on the row line');
	assert(Math.abs(multi.cardVsHead - 7) <= 1, `shell card nests 7px under the iconless row, got ${multi.cardVsHead}`);
	assert(Math.abs(multi.cardVsLabel) <= 2, `shell card aligns under the command label, got ${multi.cardVsLabel}`);

	// B) 单命令组（无组头）：行本身是浅灰命令块（无图标），卡片缩进到块内文字下方（12px）。
	const solo = bash('b-solo', 'echo solo');
	await send([user('u-solo', '一条命令'), assistant('a-solo', solo), result(solo)]);
	await page.locator('.process-group.single-command .bash-row-head').first().waitFor();
	assert.equal(await page.locator('.process-group.single-command .bash-row.ok .bash-state').first().evaluate(el => getComputedStyle(el).display), 'none', 'single command block drops the terminal icon');
	await page.locator('.process-group.single-command .bash-row-head').first().click();
	await page.locator('.process-group.single-command .bash-row-body .bash-shell-card').first().waitFor();
	const single = await geometry(page);
	assert.equal(single.paddingLeft, '12px', 'single-command body padding-left');
	assert(Math.abs(single.cardVsHead - 12) <= 1, `single-command shell card nests 12px, got ${single.cardVsHead}`);
	assert(Math.abs(single.cardVsLabel) <= 2, `single-command card aligns under label, got ${single.cardVsLabel}`);
	assert(single.bodyVsHead === 0, 'single-command body block stays on the row line');

	// C) 命令 + 图片读取同轮：读取不进命令组（2026-12 用户决定）——组头只写
	// 「运行了命令」，读取行在组外正文行级，✓ 与组头图标同一条左线，
	// 展开的图片缩进在读取行标签列（24px）。
	const imgRead = { type: 'toolCall', id: 'read1', name: 'read', argumentsText: JSON.stringify({ path: 'assets/icon.png' }) };
	const imgResult = { id: 'r-read1', role: 'toolResult', toolCallId: 'read1', toolName: 'read', isError: false, toolOutputUrl: '/api/tool-output?toolCallId=read1', content: [{ type: 'text', text: 'Read image file [image/jpeg]\n[Image: original 3136x240, displayed at 2000x153. Multiply coordinates by 1.57 to map to original image.]' }, { type: 'image', dataUrl: 'data:image/png;base64,' + readFileSync('build/icon.png').toString('base64') }] };
	await send([user('u-mixed', '跑命令再读图'), assistant('a-mixed', c1, c2, imgRead), result(c1), result(c2), imgResult]);
	await page.locator('.toolcall-read .tool-result-image img').waitFor();
	const summaryText = await page.locator('.process-group-summary-line').first().innerText();
	assert.match(summaryText, /运行了命令/, 'command group keeps its label');
	assert(!/已读取/.test(summaryText), `read no longer joins the command group header (got ${summaryText})`);
	const mixed = await page.evaluate(() => {
		const x = sel => document.querySelector(sel).getBoundingClientRect().left;
		const group = document.querySelector('.process-group');
		const read = document.querySelector('.toolcall-read');
		const state = document.querySelector('.toolcall-read .toolcall-read-state');
		const iconBox = document.querySelector('.toolcall-read .toolcall-read-icon').getBoundingClientRect();
		return {
			readInsideGroup: group.contains(read),
			stateDisplay: getComputedStyle(state).display,
			groupHeadIcon: x('.process-group .process-group-icon'),
			readIcon: iconBox.left,
			readIconSize: iconBox.width,
			readRow: x('.toolcall-read'),
			readImage: x('.toolcall-read .tool-result-image'),
		};
	});
	assert.equal(mixed.readInsideGroup, false, 'read row renders outside the command group');
	assert.equal(mixed.stateDisplay, 'none', 'a successful read shows no ✓ state glyph');
	assert(Math.abs(mixed.readIconSize - 16) <= 1, `read icon uses the shared borderless 16px line icon, got ${mixed.readIconSize}`);
	assert(Math.abs(mixed.readIcon - mixed.groupHeadIcon) <= 2, `read icon shares the prose left line with the group icon, got ${mixed.readIcon} vs ${mixed.groupHeadIcon}`);
	assert(Math.abs(mixed.readImage - mixed.readRow - 24) <= 2, `expanded read preview nests 24px under its row, got ${mixed.readImage - mixed.readRow}`);

	assert.deepEqual(errors, [], 'no page errors');
	console.log('bash-shell-card-indent-ui-test: OK');
} finally {
	if (browser) await browser.close();
	if (server) server.kill();
	rmSync(root, { recursive: true, force: true });
}
