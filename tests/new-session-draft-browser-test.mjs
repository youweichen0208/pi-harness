// Real /new command and delayed receipt; isolated data, no model requests.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
const root = mkdtempSync(join(tmpdir(), 'pi-new-draft-'));
mkdirSync(join(root, 'agent'));
writeFileSync(join(root, 'agent', 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:8999', apiKey: 'fixture', models: [{ id: 'test', name: 'test', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
writeFileSync(join(root, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'test' }));
let server, browser;
try {
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') } });
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage();
	let socket, receipt, state;
	await page.routeWebSocket('**/ws', route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'prompt') assert.equal(message.text, '/new');
			if (message.type !== 'query_prompt_receipt') upstream.send(wire);
		});
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'snapshot') { message.state.piConfigured = true; state = message.state; }
			if (message.type === 'prompt_result') { receipt = message; return; }
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${server.port}`);
	const input = page.locator('.inputbar textarea');
	await input.waitFor();
	await page.waitForFunction(() => !document.querySelector('.inputbar textarea')?.disabled);
	const wait = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('Timed out'); };
	for (const replacement of [undefined, 'Keep my next question']) {
		await wait(() => state?.sessionId);
		const before = state.sessionId;
		receipt = undefined;
		await input.fill('/new'); await page.locator('.composer-action.send').click();
		await wait(() => receipt && state.sessionId !== before);
		assert.equal(receipt.ok, true); assert.equal(receipt.commandExecuted, true);
		if (replacement) await input.fill(replacement);
		socket.send(JSON.stringify(receipt));
		await page.waitForTimeout(150);
		assert.equal(await input.inputValue(), replacement ?? '', 'Confirmed /new must clear only its unchanged command draft');
	}
	const before = state.sessionId;
	receipt = undefined;
	await input.fill('/new'); await page.locator('.composer-action.send').click();
	await wait(() => receipt && state.sessionId !== before);
	const oldReceipt = receipt;
	state = undefined;
	await page.reload();
	await wait(() => state?.sessionId && state.sessionId !== before);
	await page.waitForFunction(() => !document.querySelector('.inputbar textarea')?.disabled);
	await input.fill('/new');
	socket.send(JSON.stringify(oldReceipt));
	await page.waitForTimeout(150);
	assert.equal(await input.inputValue(), '/new', 'Recovered old-session receipts must retain the draft');
	console.log('PASS /new clears its command, preserves newer input, and protects drafts after reload');
} finally {
	await browser?.close(); await server?.stop(); rmSync(root, { recursive: true, force: true });
}
