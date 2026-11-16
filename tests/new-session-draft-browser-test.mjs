import { mergeSnapshot } from "./lib/snapshots.mjs";
// Real /new command and delayed receipt; isolated data, no model requests.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const root = mkdtempSync(join(tmpdir(), 'omp-new-draft-')), agent = join(root, 'data/omp/agent');
mkdirSync(agent, { recursive: true });
let calls = 0;
const provider = createServer((req, res) => { calls++; req.resume(); res.writeHead(500); res.end('Commands must not invoke a model'); });
let server, browser;
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'test', contextWindow: 32000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ model: 'fixture/test', skills: { enabled: false }, cacheWarming: { enabled: false } }));
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data') } });
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
			state = mergeSnapshot(state, message);
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
	assert.equal(calls, 0, 'native /new never calls the provider');
	console.log('PASS /new clears its command, preserves newer input, and protects drafts after reload');
	await page.close(); await server.stop(); server = undefined;
	const emptyData = join(root, 'unconfigured'), emptyAgent = join(emptyData, 'omp/agent');
	mkdirSync(emptyAgent, { recursive: true });
	writeFileSync(join(emptyAgent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
	const env = testEnv({ PI_WEB_CWD: root, PI_WEB_DATA_DIR: emptyData });
	for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
	server = await startIsolatedHarness({ env });
	const unconfigured = await browser.newPage(); const sent = [], received = []; let emptyState, ready = false, catalog = [];
	unconfigured.on('websocket', ws => {
		ws.on('framesent', ({ payload }) => sent.push(JSON.parse(String(payload))));
		ws.on('framereceived', ({ payload }) => {
			const event = JSON.parse(String(payload)); received.push(event);
			emptyState = mergeSnapshot(emptyState, event);
			if (event.type === 'ready') ready = true;
			if (event.type === 'slash_commands') catalog = event.commands;
		});
	});
	await unconfigured.goto(`http://127.0.0.1:${server.port}`);
	await unconfigured.locator('.setup-modal .modal-close').click();
	await wait(() => ready && catalog.some(command => command.name === 'context'));
	assert.equal(emptyState.model, null); assert.equal(emptyState.piConfigured, false);
	const emptyInput = unconfigured.locator('.inputbar textarea'), send = unconfigured.locator('.composer-action.send');
	await emptyInput.fill('ordinary question'); assert(await send.isDisabled());
	await emptyInput.press('Enter');
	await emptyInput.fill('/unknown-local-command'); assert(await send.isDisabled());
	assert.equal(sent.filter(event => event.type === 'prompt').length, 0, 'unavailable model still blocks ordinary prompts');
	for (const command of ['/context', '/models', '/new']) {
		const oldId = emptyState.sessionId, count = received.filter(event => event.type === 'prompt_result').length;
		await emptyInput.fill(command);
		assert(await send.isEnabled(), `${command} must reach native dispatch without a model`);
		await send.click();
		await wait(() => received.filter(event => event.type === 'prompt_result').length > count && !emptyState.isStreaming);
		const result = received.filter(event => event.type === 'prompt_result').at(-1);
		assert.equal(result.commandExecuted, true); assert.equal(result.attachmentsConsumed, false);
		await unconfigured.waitForFunction(() => document.querySelector('.inputbar textarea').value === '');
		assert.equal(await unconfigured.locator('.pending-echo').count(), 0);
		assert.equal(await unconfigured.locator('.slash-menu').count(), 0, 'acknowledged commands close the picker with their draft');
		if (command === '/new') assert.notEqual(emptyState.sessionId, oldId);
		else await unconfigured.locator('.omp-command-output pre').last().waitFor();
		assert.equal(emptyState.messages.length, 0); assert.equal(emptyState.model, null);
	}
	assert.equal(calls, 0);
	console.log('PASS no-model commands: native /context, /models and /new remain available; plain text and unknown commands stay blocked');
} finally {
	await browser?.close(); await server?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
