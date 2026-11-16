// Zero-token real transport: command side effects, reconnect, restart and crash window.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete process.env[key];
let port;
const base = mkdtempSync(join(tmpdir(), 'prompt-receipts-'));
const workspace = join(base, 'work'), agent = join(base, 'data/omp/agent'), count = join(base, 'count'), release = join(base, 'release'), completed = join(base, 'completed'), pending = join(base, 'pending');
mkdirSync(workspace); mkdirSync(join(agent, 'extensions'), { recursive: true });
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false } }));
writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', apiKey: 'local-only', models: [{ id: 'fixture' }] } } }));
writeFileSync(join(agent, 'extensions', 'receipt.js'), `import { appendFileSync, existsSync } from 'node:fs';
export default function(omp) {
 omp.on('input', async event => {
 if (event.text !== 'receipt-pending') return;
 appendFileSync(${JSON.stringify(pending)}, 'pending\\n');
 while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20));
 return { handled: true };
 });
 omp.registerCommand('receipt-test', { description: 'Receipt fixture', handler: async (args) => {
 appendFileSync(${JSON.stringify(count)}, 'called\\n');
 if (args === 'hold') while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20));
 if (args === 'slow') await new Promise(resolve => setTimeout(resolve, 3000));
 appendFileSync(${JSON.stringify(completed)}, 'done\\n');
 } });
}`);
let harness, ws, browser;
async function start() {
	harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: join(base, 'data'), PI_WEB_CWD: workspace }, ...(port ? { nextPort: () => port, attempts: 1 } : {}), onOutput: text => { if (process.env.DEBUG_RECEIPTS) process.stderr.write(text); } });
	port = harness.port;
}
async function stop(signal = 'SIGTERM') {
	ws?.terminate();
	if (!harness) return;
	if (signal === 'SIGKILL' && harness.child.exitCode === null && harness.child.signalCode === null) {
		const exited = once(harness.child, 'exit'); harness.child.kill(signal); await exited;
	}
	await harness.stop(); harness = undefined;
}
function wait(predicate) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('receipt timeout')); }, 30000);
		const receive = wire => { const m = JSON.parse(wire); if (process.env.DEBUG_RECEIPTS) console.log(m.type, m.receipt, m.text ?? ''); if (predicate(m)) { clearTimeout(timer); ws.off('message', receive); resolve(m); } };
		ws.on('message', receive);
	});
}
async function connect(client = 'receipt-client') {
	ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const ready = wait(m => m.type === 'ready');
	await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', clientId: client }));
	await ready;
	const snapshot = wait(m => m.type === 'snapshot'); ws.send(JSON.stringify({ type: 'get_state' }));
	return (await snapshot).state;
}
async function connectAfterClosing() { ws?.terminate(); return connect(); }
async function exchange(message) {
	if (process.env.DEBUG_RECEIPTS) console.log('SEND', message.type, message.requestId);
	const result = wait(m => m.type === 'prompt_result' && m.requestId === message.requestId);
	ws.send(JSON.stringify(message)); return result;
}
const calls = () => existsSync(count) ? readFileSync(count, 'utf8').trim().split('\n').length : 0;
const waitCompleted = async expected => {
	for (let i = 0; i < 500; i++) {
		if (readFileSync(completed, 'utf8').trim().split('\n').length === expected) return;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw Error('Native extension command did not complete');
};
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
	assert.equal((await exchange({ ...prompt, requestId: 'stale', target: { ...target, sessionId: 'stale-native-session' } })).receipt, 'rejected'); assert.equal(calls(), 1);
	const slow = { type: 'prompt', requestId: 'crash', text: '/receipt-test hold', target: { cwd: state.cwd, conversationId: state.conversationId, sessionId: state.sessionId } };
	ws.send(JSON.stringify(slow));
	for (let i = 0; i < 100 && calls() < 2; i++) await new Promise(r => setTimeout(r, 20));
	assert.equal(calls(), 2);
	assert.equal(readFileSync(completed, 'utf8'), 'done\n', 'held extension command has not finished');
	assert.equal((await exchange({ type: 'query_prompt_receipt', requestId: 'crash' })).receipt, 'accepted', 'native extension routing is admission, not completion');
	await stop('SIGKILL'); await start(); await connect();
	assert.equal((await exchange({ type: 'query_prompt_receipt', requestId: 'crash' })).receipt, 'accepted');
	assert.equal((await exchange(slow)).receipt, 'accepted'); assert.equal(calls(), 2);
	state = await connectAfterClosing();
	const beforeAck = { type: 'prompt', requestId: 'before-ack', text: 'receipt-pending', target: { cwd: state.cwd, conversationId: state.conversationId, sessionId: state.sessionId } };
	ws.send(JSON.stringify(beforeAck));
	for (let i = 0; i < 500 && !existsSync(pending); i++) await new Promise(r => setTimeout(r, 20));
	assert.equal(readFileSync(pending, 'utf8'), 'pending\n');
	assert.equal((await exchange({ type: 'query_prompt_receipt', requestId: 'before-ack' })).receipt, 'processing');
	await stop('SIGKILL'); await start(); await connect();
	assert.equal((await exchange({ type: 'query_prompt_receipt', requestId: 'before-ack' })).receipt, 'unknown');
	assert.equal((await exchange(beforeAck)).receipt, 'unknown');
	assert.equal(readFileSync(pending, 'utf8'), 'pending\n', 'input hook side effects must never replay');
	ws.terminate(); await connect('other-client');
	assert.equal((await exchange({ type: 'query_prompt_receipt', requestId: 'once' })).receipt, 'missing');
	console.log('PASS OMP durable prompt protocol: dedup, conflict, ownership, restart and crash unknown');
	if (process.argv.includes('--browser')) {
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
	await waitCompleted(2);
	await input.fill('/receipt-test slow'); await input.press('Enter');
	for (let i = 0; i < 100 && calls() < 4; i++) await new Promise(r => setTimeout(r, 20));
	assert.equal(calls(), 4); await page.reload();
	await page.waitForFunction(() => !Object.keys(sessionStorage).some(key => key.startsWith('pi-pending-prompt:')));
	assert.equal(await input.inputValue(), ''); assert.equal(prompts, 2); assert.equal(calls(), 4);
	await waitCompleted(3);
	unknown = true; await input.fill('/receipt-test uncertain'); await input.press('Enter');
	await page.getByRole('status').filter({ hasText: '发送结果尚未确认' }).waitFor();
	assert.equal(await input.inputValue(), '/receipt-test uncertain'); assert.equal(calls(), 4);
	unknown = false; await input.press('Enter');
	await page.waitForFunction(() => document.querySelector('.inputbar textarea')?.value === '');
	assert.equal(calls(), 5); assert.deepEqual(pageErrors, []);
	console.log('PASS OMP prompt receipt browser: reconnect/refresh queries without replay, newer draft retained, explicit retry');
	}
} finally { await browser?.close(); await stop(); rmSync(base, { recursive: true, force: true }); }
