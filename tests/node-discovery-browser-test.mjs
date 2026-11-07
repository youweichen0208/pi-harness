/** No SSH connections or model calls: exercise discovery through a local WebSocket fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';
const port = 9297, root = mkdtempSync(join(tmpdir(), 'pi-node-discovery-browser-'));
let server, browser, discoveries = 0;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: testEnv({ PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }), stdio: 'ignore' });
	for (let i = 0; i < 150 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage(); page.setDefaultTimeout(12000);
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	await page.routeWebSocket('**/ws', route => {
		const upstream = route.connectToServer();
		route.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type === 'node_request' && message.action === 'source_detect') {
				discoveries++;
				route.send(JSON.stringify({ type: 'node_event', event: 'result', requestId: message.requestId, data: { action: 'source_detect', sources: [] } }));
			} else upstream.send(wire);
		});
		upstream.onMessage(wire => route.send(wire));
	});
	await page.clock.install();
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.setup-modal .modal-close').click();
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.getByRole('tab', { name: '节点', exact: true }).click();
	await page.locator('.node-workbench').waitFor();
	await page.waitForTimeout(100); assert(discoveries >= 1);
	await page.clock.fastForward(15000);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await page.waitForTimeout(100);
	let before = discoveries; await page.clock.fastForward(15000);
	await page.waitForTimeout(100); assert(discoveries > before);
	before = discoveries; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await page.waitForTimeout(100); assert(discoveries > before);
	await page.getByRole('tab', { name: '对话', exact: true }).click();
	before = discoveries; await page.clock.fastForward(60000);
	await page.waitForTimeout(100); assert.equal(discoveries, before);
	assert.deepEqual(errors, []);
	console.log('PASS node discovery UI: initial discovery, periodic discovery, focus refresh, hidden view cleanup');
} finally {
	await browser?.close();
	if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
	rmSync(root, { recursive: true, force: true });
}
