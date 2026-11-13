/** Focused browser regression for the compact composer toolbar. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";

const port = 8996;
const root = mkdtempSync(join(tmpdir(), 'pi-composer-toolbar-'));
let server, browser;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = ''; server.stderr.on('data', (chunk) => { stderr += chunk; });
	for (let i = 0; i < 80 && !await portUp(port); i++) await sleep(200);
	assert(await portUp(port), stderr);
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
	let socket, state;
	const sent = [];
	await page.routeWebSocket('**/ws', (route) => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage((wire) => { const msg = JSON.parse(wire.toString()); sent.push(msg); if (msg.type !== 'set_thinking') upstream.send(wire); });
		upstream.onMessage((wire) => { const msg = JSON.parse(wire.toString()); if (msg.type === 'snapshot') { if (!state) { state = msg.state; route.send(wire); } } else if (msg.type !== "snapshot_delta") route.send(wire); });
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.inputbox textarea').waitFor();
	for (let i = 0; i < 50 && !state; i++) await sleep(100);
	assert(state, 'initial snapshot');
	state = { ...state, rev: state.rev + 1, tree: state.tree ? { ...state.tree, verifying: false } : undefined, isStreaming: true, piConfigured: true, stats: { ...state.stats, tokens: { input: 6, cacheRead: 94, cacheWrite: 0, output: 10 } }, model: { id: 'glm-5.3', name: 'GLM 5.3 (Volc)', provider: 'volc' }, thinkingLevel: 'high', availableThinkingLevels: ['minimal', 'medium', 'high'] };
	socket.send(JSON.stringify({ type: 'snapshot', state }));
	await page.locator('.input-tools .chip-model', { hasText: 'GLM 5.3' }).waitFor();
	assert.equal(await page.locator('.thinking-control, .delivery-control').count(), 0);
	await page.locator('.input-tools-left > .dropdown .chip').click();
	assert.equal(await page.locator('.dd-thinking-levels, .dd-menu-thinking').count(), 0);
	assert.equal(sent.some((msg) => msg.type === 'set_thinking'), false);
	assert.equal(await page.locator('.model-run-settings input').count(), 2);
	await page.keyboard.press('Escape');
	await page.locator('.inputbox textarea').fill('顺便修改文件名');
	await page.locator('.input-tools .btn.send:enabled').waitFor();
	assert.equal(await page.locator('.delivery-control').count(), 0);
	await page.setViewportSize({ width: 460, height: 900 });
	assert.equal(await page.locator('.thinking-trigger-prefix').count(), 0, 'narrow composer has no thinking trigger');
	assert.equal(await page.locator('.usage-cache-short').isVisible(), false, 'narrow composer hides cache summary');
	assert.match(await page.locator('.usage-trigger').innerText(), /^(?:\d+%|—)$/, 'context percentage or unknown marker is visible outside the popover');
	await page.locator('.usage-trigger .usage-meter').waitFor({ state: 'visible' });
	await page.locator('.usage-trigger').hover();
	await page.locator('.usage-popover').waitFor({ state: 'visible' });
	await page.locator('.usage-popover').hover();
	assert(await page.locator('.usage-popover').isVisible(), 'details remain open while hovered');
	await page.mouse.move(0, 0);
	await page.locator('.usage-popover').waitFor({ state: 'hidden' });
	const toolbar = await page.locator('.input-tools').evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth, stop: element.querySelector('.btn.stop').getBoundingClientRect().width }));
	assert(toolbar.content <= toolbar.width + 1, `composer toolbar must fit 460px: ${JSON.stringify(toolbar)}`);
	assert(toolbar.stop === 32, 'stop button keeps its size');
	await page.setViewportSize({ width: 1500, height: 900 });
	await page.locator('.usage-trigger').click();
	await page.locator('.usage-popover .usage-cache-section').first().waitFor();
	await page.locator('.usage-trigger').click();
	await page.setViewportSize({ width: 390, height: 900 });
	assert.equal(await page.locator('.input-tools-left .chip-model').isVisible(), false, 'smallest composer keeps only model icon');
	const smallest = await page.locator('.input-tools').evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
	assert(smallest.content <= smallest.width + 1, `composer toolbar must fit 390px: ${JSON.stringify(smallest)}`);
	console.log('composer toolbar UI passed');
} finally {
	await browser?.close();
	if (server?.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(2000)]); }
	rmSync(root, { recursive: true, force: true });
}
