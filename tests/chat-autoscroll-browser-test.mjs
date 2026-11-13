/**
 * 对话贴底跟随：停在底部时随流式内容一起往下走；一旦用户自己往上翻（滚轮、
 * 拖动、跳转、搜索），就不再被新内容拉回去；重新滚回底部后恢复跟随。
 * 真实前端 + 隔离服务端，模型输出用 WS 路由注入（零 token）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'pi-autoscroll-'));
const at = Date.now();
const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(6);
const messages = [];
for (let i = 0; i < 24; i++) {
	messages.push({ id: `u${i}`, role: 'user', timestamp: at + i * 2000, content: [{ type: 'text', text: `Q${i} ${filler}` }] });
	messages.push({ id: `a${i}`, role: 'assistant', timestamp: at + i * 2000 + 1000, content: [{ type: 'text', text: `A${i} ${filler}` }] });
}
/** 滚动容器的位置读数；d 就是「距离最新内容的像素数」。 */
const scrollState = page => page.evaluate(() => {
	const el = document.querySelector('.messages');
	return { top: Math.round(el.scrollTop), height: el.scrollHeight, client: el.clientHeight, distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
});
let harness, browser;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors = [];
	page.on('pageerror', error => errors.push(String(error)));
	let socket, baseline, live = 'start ', seq = 0;
	await page.routeWebSocket('**/ws', route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(wire => upstream.send(wire));
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'snapshot') {
				message.state = { ...message.state, piConfigured: true, messages, isStreaming: true, streamingMessage: { id: 'live', role: 'assistant', timestamp: at + 999999, content: [{ type: 'text', text: live }] } };
				baseline = message.state;
			}
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${harness.port}`);
	await page.locator('[data-msg-id="a23"]').waitFor();
	await page.waitForTimeout(700);
	const stream = chunk => {
		live += chunk;
		seq += 1;
		socket.send(JSON.stringify({ type: 'message_delta', conversationId: baseline.conversationId, seq, messageId: 'live', usage: null, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk } }));
	};
	const streamFrames = async count => {
		for (let i = 0; i < count; i++) { stream(`${filler} `); await page.waitForTimeout(120); }
		await page.waitForTimeout(250);
	};
	const center = await page.locator('.messages').boundingBox();
	await page.mouse.move(center.x + center.width / 2, center.y + center.height / 2);

	// 1) 停在底部：每帧新内容都把视口带到最新（高度变高、距离为 0）。
	const initial = await scrollState(page);
	assert.equal(initial.distance, 0, '挂载后就在底部');
	await streamFrames(3);
	const followed = await scrollState(page);
	assert(followed.height > initial.height, '流式内容确实变高了');
	assert.equal(followed.distance, 0, '停在底部时跟随流式内容');

	// 2) 往上翻：新内容不再拉动视口。
	await page.mouse.wheel(0, -900);
	await page.waitForTimeout(300);
	const escaped = await scrollState(page);
	assert(escaped.distance > 200, '滚轮向上后离开底部');
	await streamFrames(3);
	const parked = await scrollState(page);
	assert.equal(parked.top, escaped.top, '往上翻后视口不被新内容拉走');
	assert(parked.distance > escaped.distance, '新内容继续在下方增长');

	// 3) 跳转到旧消息：跳转保持原位，也不被流式内容拉回底部。
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:jump-message', { detail: { messageId: 'u10' } })));
	await page.waitForTimeout(600);
	const jumped = await scrollState(page);
	assert.equal(await page.evaluate(() => { const r = document.querySelector('[data-msg-id="u10"]').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }), true, '跳转目标在视口内');
	await streamFrames(2);
	assert.equal((await scrollState(page)).top, jumped.top, '跳转后不被拉回底部');

	// 4) 滚回底部：恢复跟随。
	for (let i = 0; i < 16; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(100); }
	await page.waitForTimeout(300);
	assert.equal((await scrollState(page)).distance, 0, '滚回底部');
	await streamFrames(2);
	assert.equal((await scrollState(page)).distance, 0, '滚回底部后重新跟随');

	// 5) 会话内搜索：命中定位优先，流式内容不抢滚动。
	await page.keyboard.press('ControlOrMeta+f');
	await page.locator('.search-input').waitFor();
	await page.locator('.search-input').fill('Q3');
	await page.waitForTimeout(600);
	const searching = await scrollState(page);
	assert(searching.distance > 200, '搜索跳到命中处');
	await streamFrames(2);
	assert.equal((await scrollState(page)).top, searching.top, '搜索期间不被流式内容拉走');

	assert.deepEqual(errors, []);
	console.log('PASS chat autoscroll: follow at bottom, park on wheel-up, keep jump/search position, re-follow at bottom');
} finally {
	await browser?.close();
	await harness?.stop();
	rmSync(root, { recursive: true, force: true });
}
