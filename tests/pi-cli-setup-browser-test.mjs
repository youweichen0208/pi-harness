/** Pi installation UI: intercept every install command; never install a global package. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
const root = mkdtempSync(join(tmpdir(), 'pi-cli-ui-'));
let server, browser;
try {
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') } });
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	for (const lang of ['zh', 'en']) {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		page.setDefaultTimeout(10000);
		await page.addInitScript(lang => { localStorage.setItem('pi-harness:lang', lang); Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copiedCommand = text; } } }); }, lang);
		const commands = [];
		let checkedRoute = false;
		const skills = ['user', 'project', 'package'].map((source, i) => ({ id: `fixture-${i}`, name: `sample-${source}`, description: 'A long skill description that remains readable across narrow layouts and wraps without hiding instructions.', enabled: true, path: `/fixture/${source}/SKILL.md`, source, scope: source === 'project' ? 'project' : 'user', canToggle: true, promptVisible: true }));
		let state = { pi: { status: 'missing' }, node: { status: 'missing' }, npm: { status: 'missing' }, canInstall: false };
		await page.route('**/api/extensions', async route => {
			const body = route.request().postDataJSON();
			if (['skills-list', 'skills-toggle'].includes(body.action)) {
				if (body.action === 'skills-toggle') skills.find(skill => skill.id === body.id).enabled = body.enabled;
				return route.fulfill({ json: { version: 'fixture', paths: ['/fixture/skills'], skills } });
			}
			if (body.action === 'cli-status') {
				if (!checkedRoute) {
					checkedRoute = true;
					const actual = await route.fetch();
					assert.equal(actual.status(), 200);
					assert(['available', 'missing', 'unusable'].includes((await actual.json()).pi.status));
					// #151: PATH probing does not belong to a workspace, so a stale or wrong cwd
					// must not block it — only quiescing (shutdown/restart) answers 409.
					const wrongCwd = await route.fetch({ postData: JSON.stringify({ ...route.request().postDataJSON(), cwd: '/not-the-workspace' }) });
					assert.equal(wrongCwd.status(), 200);
					assert(['available', 'missing', 'unusable'].includes((await wrongCwd.json()).pi.status));
				}
				return route.fulfill({ json: state });
			}
			await route.continue();
		});
		await page.routeWebSocket('**/ws', route => {
			const upstream = route.connectToServer();
			route.onMessage(raw => {
				const message = JSON.parse(String(raw));
				if (message.type === 'prompt') throw Error('No model calls');
				if (message.type === 'run_command') { commands.push(message); return; }
				if (message.type.startsWith('terminal_')) return;
				upstream.send(raw);
			});
			upstream.onMessage(raw => {
				const message = JSON.parse(String(raw));
				if (message.type === 'snapshot') message.state.piConfigured = true;
				if (message.type !== 'terminal_list') route.send(JSON.stringify(message));
			});
		});
		const open = async () => {
			await page.locator('#sidebar-settings-slot button:visible').click();
			await page.locator('#sidebar-settings-slot .dd-item', { hasText: lang === 'zh' ? '设置' : 'Settings' }).click();
			assert.equal(await page.locator('.settings-tab').count(), 5);
			assert.equal(await page.locator('.settings-tab', { hasText: lang === 'zh' ? /代码运行|更新/ : /Playground|Updates/ }).count(), 0);
			await page.locator('.settings-tab', { hasText: 'Extensions' }).click();
			await page.locator('.pi-cli-setup button').first().waitFor();
		};
		const install = () => page.locator('.pi-cli-setup').getByRole('button', { name: lang === 'zh' ? '安装 Pi CLI' : 'Install Pi CLI', exact: true });
		await page.goto(`http://127.0.0.1:${server.port}`);
		await open();
		await page.locator('.settings-tab', { hasText: lang === 'zh' ? '技能' : 'Skills' }).click();
		await page.locator('.settings-skill-row').first().waitFor();
		assert.equal(await page.locator('.settings-skill-row').count(), 3);
		assert.equal(await page.locator('.skills-counts > span').count(), 3);
		await page.locator('.skills-search input').fill('sample-project');
		assert.equal(await page.locator('.settings-skill-row').count(), 1);
		await page.locator('.skills-search input').fill('');
		await page.locator('.skills-filters .settings-segment button').nth(1).click();
		assert.equal(await page.locator('.settings-skill-row').count(), 1);
		await page.locator('.settings-skill-row [role="switch"]').click();
		await page.locator('.settings-skill-row.disabled').waitFor();
		await page.locator('.skills-filters .settings-segment button').first().click();
		mkdirSync('tests/scratch/extensions-layout', { recursive: true });
		await page.screenshot({ path: `tests/scratch/extensions-layout/${lang}-skills.png` });
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await page.locator('.settings-skills').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
		await page.screenshot({ path: `tests/scratch/extensions-layout/${lang}-skills-narrow.png` });
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.locator('.settings-tab', { hasText: 'Extensions' }).click();
		await install().waitFor();
		assert(await install().isDisabled());
		assert.match(await page.locator('.pi-cli-setup').innerText(), /22.19/);
		assert.equal(await page.locator('.pi-cli-tool').count(), 3);
		await page.locator('.pi-cli-command .copy-btn').click();
		assert.equal(await page.evaluate(() => window.__copiedCommand), 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest');
		await page.locator('.builtin-icon').first().waitFor();
		assert.equal(await page.locator('.builtin-icon').count(), 5, 'native plan is no longer listed');
		mkdirSync('tests/scratch/extensions-layout', { recursive: true });
		await page.screenshot({ path: `tests/scratch/extensions-layout/${lang}-light.png` });
		await page.locator('.builtin-extensions').scrollIntoViewIfNeeded();
		await page.screenshot({ path: `tests/scratch/extensions-layout/${lang}-builtins.png` });
		await page.locator('.pi-cli-setup').scrollIntoViewIfNeeded();
		await page.evaluate(() => document.documentElement.dataset.appearance = 'dark');
		await page.screenshot({ path: `tests/scratch/extensions-layout/${lang}-dark.png` });
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await page.locator('.extensions-v3').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'cards must fit narrow settings');
		await page.screenshot({ path: `tests/scratch/extensions-layout/${lang}-narrow.png` });
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.evaluate(() => document.documentElement.dataset.appearance = 'light');
		state = { pi: { status: 'missing' }, node: { status: 'available', version: '22.19.0' }, npm: { status: 'available', version: '10.9.0' }, canInstall: true };
		await page.locator('.pi-cli-setup').getByRole('button', { name: lang === 'zh' ? '重新检测' : 'Check again' }).click();
		await page.waitForFunction(() => !document.querySelector('.pi-cli-install')?.disabled);
		await install().click();
		await page.locator('.term-tab.active', { hasText: 'Install Pi CLI' }).waitFor();
		for (let i = 0; i < 50 && !commands.length; i++) await page.waitForTimeout(100);
		assert.equal(commands.length, 1);
		assert.equal(commands[0].command.command, 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest');
		assert(commands[0].conversationId);
		assert.equal(await page.locator('.settings-modal').count(), 0);
		// The settings backdrop can outlive the modal for a frame and swallow the click.
		await page.locator('.modal-backdrop').waitFor({ state: 'detached' });
		await page.getByTitle(lang === 'zh' ? '新建终端' : 'New terminal', { exact: true }).click();
		await open(); await install().click();
		await page.locator('.term-tab.active', { hasText: 'Install Pi CLI' }).waitFor();
		assert.equal(commands.length, 1, 'reopening must not restart installation');
		state = { ...state, pi: { status: 'available', version: '1.5.0' }, canInstall: false };
		await open();
		await page.locator('.pi-cli-tool', { hasText: 'Pi CLI · 1.5.0' }).waitFor();
		assert.equal(await install().count(), 0);
		state = { ...state, pi: { status: 'unusable' } };
		await page.locator('.pi-cli-setup').getByRole('button', { name: lang === 'zh' ? '重新检测' : 'Check again' }).click();
		await page.locator('.pi-cli-setup').getByText(lang === 'zh' ? /无法运行/ : /Cannot run/).first().waitFor();
		assert.equal(await install().count(), 0);
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
		await page.close();
		console.log(`PASS ${lang}: prerequisites, visible terminal, exact latest command, no duplicate install, redetection`);
	}
} finally { await browser?.close(); await server?.stop(); rmSync(root, { recursive: true, force: true }); }
