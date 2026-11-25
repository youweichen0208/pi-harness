/**
 * The file column belongs to the workbench, not to the conversation: Terminal,
 * Git and Nodes keep it docked, and the top bar keeps its toggle. The column is
 * a sibling of the panes (`.layout > .drawer-right`) so switching views never
 * unmounts the tree.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 8977;
assert.equal(await portUp(port), false, `Port ${port} busy`);
const root = mkdtempSync(join(tmpdir(), 'pi-files-views-'));
const cwd = join(root, 'workspace');
mkdirSync(join(cwd, 'src'), { recursive: true });
writeFileSync(join(cwd, 'README.md'), '# demo\n');
writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
execFileSync('git', ['init', '-q'], { cwd });

let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 150 && !await portUp(port); i++) await sleep(100);
	assert(await portUp(port), 'server starts');

	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(12000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.routeWebSocket('**/ws', route => {
		const upstream = route.connectToServer();
		route.onMessage(wire => upstream.send(wire));
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'snapshot') {
				route.send(JSON.stringify({ ...message, state: { ...message.state, piConfigured: true, isStreaming: false, messages: [] } }));
				return;
			}
			if (message.type !== 'snapshot_delta') route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.view-switch').waitFor();
	await sleep(700);

	const drawer = page.locator('.layout > .drawer-right');
	const toggle = page.locator('.workspace-files-toggle');
	const width = async () => Math.round((await drawer.boundingBox())?.width ?? 0);
	const state = async () => ({ visible: await drawer.isVisible(), width: await width(), expanded: await toggle.getAttribute('aria-expanded') });

	// The column is owned by the workbench, not by a view pane.
	assert.equal(await drawer.count(), 1, 'file column renders as a layout-row child');
	assert.equal(await page.locator('.view-pane .drawer-right').count(), 0, 'file column is not nested in a view pane');
	const chat = await state();
	assert.equal(chat.visible, true, 'chat docks the file column');
	assert.equal(chat.expanded, 'true', 'top bar reports the file column as open');
	assert(chat.width >= 200, `chat file column keeps a usable width (got ${chat.width})`);

	for (const [label, name] of [['终端', 'terminal'], ['Git', 'git'], ['节点', 'nodes']]) {
		await page.locator('.view-switch button', { hasText: label }).first().click();
		await sleep(350);
		const result = await state();
		assert.equal(result.visible, true, `${name}: file column stays docked`);
		assert.equal(result.expanded, 'true', `${name}: file toggle stays available`);
		assert.equal(result.width, chat.width, `${name}: file column keeps its width`);
		assert.equal(await page.locator('.layout > .resize-right').count(), 1, `${name}: column stays resizable`);
		// The tree is live, not a stale snapshot from the conversation view.
		assert.equal(await page.locator('.right-files-pane').isVisible(), true, `${name}: file tree is visible`);
	}

	// The toggle works from a non-chat view and brings the column back.
	await toggle.click();
	await sleep(250);
	assert.equal(await drawer.isVisible(), false, 'terminal: toggle collapses the file column');
	await toggle.click();
	await sleep(250);
	assert.equal(await drawer.isVisible(), true, 'terminal: toggle restores the file column');

	await page.locator('.view-switch button', { hasText: '对话' }).first().click();
	await sleep(300);
	assert.equal(await drawer.isVisible(), true, 'conversation keeps the file column after the round trip');

	// Narrow desktop keeps the same contract: a dock when it fits, otherwise the
	// usual overlay drawer that the same toggle opens.
	await page.setViewportSize({ width: 1100, height: 900 });
	await sleep(300);
	assert.equal(await drawer.isVisible(), true, '1100px: file column stays docked');
	await page.setViewportSize({ width: 900, height: 900 });
	await sleep(300);
	if (!await drawer.isVisible()) {
		await toggle.click();
		await sleep(400);
		assert.equal(await drawer.isVisible(), true, '900px: toggle opens the file drawer');
	}

	assert.deepEqual(errors, []);
	console.log('PASS file column and its toggle persist across terminal, git and nodes views');
} finally {
	await browser?.close().catch(() => {});
	server?.kill('SIGTERM');
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}