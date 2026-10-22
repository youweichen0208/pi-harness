import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from "./lib/test-env.mjs";
const port = 9297, root = mkdtempSync(join(tmpdir(), 'pi-main-chat-'));
execFileSync('git', ['init', '-q'], { cwd: root });
writeFileSync(join(root, 'example.txt'), 'Preview content\n');
let server, browser;
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 150 && !await portUp(port); i++) await new Promise(r => setTimeout(r, 100));
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	mkdirSync('tests/scratch', { recursive: true });
	for (const platform of ['web', 'win32', 'darwin']) {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		const errors = [];
		let socket, snapshot;
		page.on('pageerror', error => errors.push(error.message));
		await page.addInitScript(platform => {
			if (platform !== 'web') window.electronAPI = { platform, windowAction() {}, onWindowState() { return () => {}; } };
			localStorage.setItem('pi-harness:theme-follow', 'false');
		}, platform);
		await page.routeWebSocket('**/ws', route => {
			socket = route;
			const upstream = route.connectToServer();
			route.onMessage(wire => upstream.send(wire));
			upstream.onMessage(wire => {
				const message = JSON.parse(String(wire));
				if (message.type === 'snapshot') Object.assign(message.state, { piConfigured: true, taskProgress: null, messages: [
					{ id: 'user', role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: '检查主聊天页的导航与阅读体验' }] },
					{ id: 'answer', role: 'assistant', timestamp: Date.now(), content: [{ type: 'text', text: '正文保留清晰的层级。\n\n第二段展示中文、English 和 `inline code`。\n\n- 导航入口按窗口宽度收纳\n- 文件预览和草稿保持可用\n\n```js\nconst message = "Hello";\n```' }] },
				] });
				if (message.type === 'plugins') message.plugins = Array.from({ length: 12 }, (_, i) => ({ id: `demo-${i}`, name: `插件 ${i} · ${'长名称'.repeat(8)}`, description: 'layout fixture' }));
				if (message.type === 'snapshot') snapshot = structuredClone(message);
				if (message.type !== 'snapshot_delta') route.send(JSON.stringify(message));
			});
		});
		await page.goto(`http://127.0.0.1:${port}`);
		await page.locator('.msg-assistant').waitFor();
		const input = page.locator('.inputbox textarea:visible');
		assert((await input.boundingBox()).height < 35);
		assert.equal(await page.locator('.panel-lower').isVisible(), false);
		await input.fill('保留这份草稿');
		for (const width of [1440, 1280, 1079, 900, 768, 390]) {
			await page.setViewportSize({ width, height: 900 });
			await page.waitForTimeout(150);
			const more = page.locator('.navigation-more > .dropdown > button');
			await more.click();
			await page.keyboard.press('End');
			assert(await page.locator('.navigation-menu .dd-item').last().evaluate(el => el === document.activeElement));
			await page.keyboard.press('Escape');
			assert(await more.evaluate(el => el === document.activeElement));
			assert.equal(await input.inputValue(), '保留这份草稿');
			const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, buttons: [...document.querySelectorAll('.topbar-actions > .panel-toggle, .navigation-more > .dropdown > button, .desktop-window-controls')].filter(el => el.getClientRects().length).map(el => ({ x: el.getBoundingClientRect().x, right: el.getBoundingClientRect().right })) }));
			assert(geometry.scroll <= width, JSON.stringify(geometry));
			assert(geometry.buttons.every(rect => rect.x >= 0 && rect.right <= width + 1), JSON.stringify(geometry));
			if (platform === 'win32') {
				const controls = await page.locator('.desktop-window-controls').boundingBox();
				const actions = await page.locator('.topbar-actions').boundingBox();
				assert(actions.x + actions.width <= controls.x + 1, 'toolbar must leave window controls clear');
			}
			for (const button of await page.locator('.navigation-more > .dropdown > button, .topbar-actions > .panel-toggle').all()) assert(await button.evaluate(el => { const b = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); }), 'navigation must be clickable');
			for (const appearance of ['light', 'dark']) {
				await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance);
				await page.waitForTimeout(200);
				await page.screenshot({ path: `tests/scratch/main-chat-${platform}-${width}-${appearance}.png` });
			}
		}
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.waitForTimeout(150);
		await page.getByRole('tab', { name: '终端', exact: true }).click();
		await page.getByRole('tab', { name: '对话', exact: true }).click();
		assert.equal(await input.inputValue(), '保留这份草稿');
		const handle = page.locator('.resize-right:visible');
		assert.equal(Math.round((await page.locator('.drawer-right').boundingBox()).width), 300);
		const drag = await handle.boundingBox();
		await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
		await page.mouse.down();
		await page.mouse.move(drag.x + drag.width / 2 - 40, drag.y + drag.height / 2);
		await page.mouse.up();
		assert.equal(Math.round((await page.locator('.drawer-right').boundingBox()).width), 340);
		assert.equal(await page.evaluate(() => localStorage.getItem('pi-harness:right-panel-width')), '340');
		await handle.dblclick();
		await handle.focus();
		await page.keyboard.press('ArrowLeft');
		assert.equal(Math.round((await page.locator('.drawer-right').boundingBox()).width), 316);
		await handle.dblclick();
		assert.equal(Math.round((await page.locator('.drawer-right').boundingBox()).width), 300);
		assert.equal(await page.locator('.panel-right .tree-search').evaluate(el => el.getBoundingClientRect().height), 32);
		snapshot.state.taskProgress = { id: 'layout-task', conversationId: snapshot.state.conversationId, sourceMessageId: 'user', title: '检查布局', status: 'running', startedAt: Date.now(), completed: 0, steps: [], plan: { revision: 1, items: [{ id: 'one', title: '验证任务进度', status: 'running' }] } };
		snapshot.state.rev += 1;
		socket.send(JSON.stringify(snapshot));
		await page.locator('.task-plan-step.running').waitFor();
		snapshot.state.taskProgress.status = 'done';
		snapshot.state.taskProgress.plan.items[0].status = 'done';
		snapshot.state.rev += 1;
		socket.send(JSON.stringify(snapshot));
		await page.locator('.task-plan-step.done').waitFor();
		const file = page.locator('.file-item.file', { hasText: 'example.txt' });
		assert.equal(await page.locator('.panel-right .file-attach.download, .panel-right .file-attach.ref').count(), 0);
		await file.hover();
		await file.locator('.file-attach.inline').click();
		assert(await page.locator('.inputbar').getByText('example.txt', { exact: false }).count() > 0);
		await file.locator('.file-name').click();
		await page.locator('.fp-embedded').waitFor();
		assert.equal(await input.inputValue(), '保留这份草稿');
		await input.fill(Array(25).fill('多行输入').join('\n'));
		assert((await input.boundingBox()).height <= 181);
		await input.fill('保留这份草稿');
		await page.locator('.navigation-more > .dropdown > button').click();
		await page.locator('.navigation-menu').getByRole('button', { name: '数据库', exact: true }).click();
		await page.locator('.database-workbench').waitFor();
		assert.equal(await input.inputValue(), '保留这份草稿');
		assert.deepEqual(errors, []);
		await page.close();
	}
	console.log('Main chat layout: Web/macOS/Windows, six widths, menu keyboard/focus, draft and screenshots passed');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	if (server) await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
	rmSync(root, { recursive: true, force: true });
}
