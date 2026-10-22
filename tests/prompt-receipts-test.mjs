// Zero-token real transport: command side effects, reconnect, restart and crash window.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';
const port = 9392, base = mkdtempSync(join(tmpdir(), 'prompt-receipts-'));
const workspace = join(base, 'work'), agent = join(base, 'agent'), count = join(base, 'count');
mkdirSync(workspace); mkdirSync(join(agent, 'extensions'), { recursive: true });
writeFileSync(join(agent, 'extensions', 'receipt.ts'), `import { appendFileSync } from 'node:fs';
export default function(pi) {
 pi.registerCommand('receipt-test', { description: 'Receipt fixture', handler: async (args) => {
 appendFileSync(${JSON.stringify(count)}, 'called\\n');
 if (args === 'slow') await new Promise(resolve => setTimeout(resolve, 3000));
 } });
}`);
let server, ws, browser;
async function start() {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: agent, PI_WEB_CWD: workspace }, stdio: ['ignore', 'pipe', 'pipe'] });
	server.stderr.on('data', data => { if (process.env.DEBUG_RECEIPTS) process.stderr.write(data); });
	for (let i = 0; i < 100 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
}
async function stop(signal = 'SIGTERM') { ws?.terminate(); if (server && server.exitCode === null) { server.kill(signal); await once(server, 'exit'); } }
function wait(predicate) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('receipt timeout')); }, 15000);
		const receive = wire => { const m = JSON.parse(wire); if (process.env.DEBUG_RECEIPTS) console.log(m.type, m.receipt, m.text ?? ''); if (predicate(m)) { clearTimeout(timer); ws.off('message', receive); resolve(m); } };
		ws.on('message', receive);
	});
}
async function connect(client = 'receipt-client') {
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	ws.on('message', wire => { if (JSON.parse(wire).type === 'ready') ws.send(JSON.stringify({ type: 'get_state' })); });
	const snapshot = wait(m => m.type === 'snapshot');
	await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', clientId: client }));
	return (await snapshot).state;
}
async function exchange(message) {
	if (process.env.DEBUG_RECEIPTS) console.log('SEND', message.type, message.requestId);
	const result = wait(m => m.type === 'prompt_result' && m.requestId === message.requestId);
	ws.send(JSON.stringify(message)); return result;
}
const calls = () => existsSync(count) ? readFileSync(count, 'utf8').trim().split('\n').length : 0;
try {
	await start(); let state = await connect();
	const target = { cwd: state.cwd, conversationId: state.conversationId, sessionId: state.sessionId };
	const prompt = { type: 'prompt', requestId: 'once', text: '/receipt-test', target };
	assert.equal((await exchange(prompt)).receipt, 'accepted'); assert.equal(calls(), 1);
	assert.equal((await exchange(prompt)).receipt, 'accepted'); assert.equal(calls(), 1);
	assert.equal((await exchange({ ...prompt, text: '/receipt-test changed' })).receipt, 'conflict'); assert.equal(calls(), 1);
	ws.terminate(); await connect();
	assert.equal((await exchange({ type: 'query_prompt_receipt', requestId: 'once' })).receipt, 'accepted');
	await stop(); await start(); state = await connect();
	assert.equal((await exchange({ type: 'query_prompt_receipt', requestId: 'once' })).receipt, 'accepted');
	assert.equal((await exchange(prompt)).receipt, 'accepted'); assert.equal(calls(), 1);
	assert.equal((await exchange({ ...prompt, requestId: 'stale' })).receipt, 'rejected'); assert.equal(calls(), 1);
	const slow = { type: 'prompt', requestId: 'crash', text: '/receipt-test slow', target: { cwd: state.cwd, conversationId: state.conversationId, sessionId: state.sessionId } };
	ws.send(JSON.stringify(slow));
	for (let i = 0; i < 100 && calls() < 2; i++) await new Promise(r => setTimeout(r, 20));
	assert.equal(calls(), 2); await stop('SIGKILL'); await start(); await connect();
	assert.equal((await exchange({ type: 'query_prompt_receipt', requestId: 'crash' })).receipt, 'unknown');
	assert.equal((await exchange(slow)).receipt, 'unknown'); assert.equal(calls(), 2);
	ws.terminate(); await connect('other-client');
	assert.equal((await exchange({ type: 'query_prompt_receipt', requestId: 'once' })).receipt, 'missing');
	// The real composer must query after disconnect/refresh without replaying input.
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage(); page.setDefaultTimeout(15000);
	let disconnectOnReceipt = true, unknown = false, prompts = 0;
	const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
	await page.routeWebSocket('**/ws*', socket => {
		const upstream = socket.connectToServer();
		socket.onMessage(raw => {
			const message = JSON.parse(String(raw));
			if (message.type === 'prompt') {
				prompts++;
				if (unknown) { socket.send(JSON.stringify({ type: 'prompt_result', requestId: message.requestId, ok: false, receipt: 'unknown' })); return; }
			}
			upstream.send(raw);
		});
		upstream.onMessage(raw => {
			const message = JSON.parse(String(raw));
			if (message.type === 'snapshot' || message.type === 'snapshot_delta') message.state.piConfigured = true;
			if (message.type === 'prompt_result' && message.receipt === 'accepted' && disconnectOnReceipt) {
				disconnectOnReceipt = false; socket.close({ code: 1012, reason: 'test reconnect' }); return;
			}
			socket.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	const input = page.locator('.inputbar textarea');
	await input.fill('/receipt-test slow'); await input.press('Enter');
	for (let i = 0; i < 100 && calls() < 3; i++) await new Promise(r => setTimeout(r, 20));
	assert.equal(calls(), 3); await input.fill('Newer draft survives reconnect');
	await page.waitForFunction(() => !Object.keys(sessionStorage).some(key => key.startsWith('pi-pending-prompt:')));
	assert.equal(await input.inputValue(), 'Newer draft survives reconnect'); assert.equal(prompts, 1); assert.equal(calls(), 3);
	await input.fill('/receipt-test slow'); await input.press('Enter');
	for (let i = 0; i < 100 && calls() < 4; i++) await new Promise(r => setTimeout(r, 20));
	assert.equal(calls(), 4); await page.reload();
	await page.waitForFunction(() => !Object.keys(sessionStorage).some(key => key.startsWith('pi-pending-prompt:')));
	assert.equal(await input.inputValue(), ''); assert.equal(prompts, 2); assert.equal(calls(), 4);
	unknown = true; await input.fill('/receipt-test uncertain'); await input.press('Enter');
	await page.getByRole('status').filter({ hasText: '发送结果尚未确认' }).waitFor();
	assert.equal(await input.inputValue(), '/receipt-test uncertain'); assert.equal(calls(), 4);
	unknown = false; await input.press('Enter');
	await page.waitForFunction(() => document.querySelector('.inputbar textarea')?.value === '');
	assert.equal(calls(), 5); assert.deepEqual(pageErrors, []);
	console.log('PASS durable prompt receipts: dedup, ownership, reconnect, restart, crash unknown');
} finally { await browser?.close(); await stop(); rmSync(base, { recursive: true, force: true }); }
