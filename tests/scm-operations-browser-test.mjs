/** Real local Git operations; no external remote or model calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
const root = mkdtempSync(join(tmpdir(), 'pi-scm-ui-')), repo = join(root, 'repo');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let server, browser;
try {
	mkdirSync(repo); git('init', '-b', 'main'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
	writeFileSync(join(repo, 'a.txt'), 'base'); git('add', '.'); git('commit', '-m', 'initial'); git('branch', 'feature');
	git('worktree', 'add', '-b', 'linked', join(root, 'linked tree'));
	execFileSync('git', ['init', '--bare', join(root, 'remote.git')], { stdio: 'ignore' });
	git('remote', 'add', 'origin', join(root, 'remote.git')); git('push', '-u', 'origin', 'main');
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: repo, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') } });
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	for (const lang of ['zh', 'en']) {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
		await page.addInitScript(lang => localStorage.setItem('pi-harness:lang', lang), lang);
		const terminalCommands = []; let identity;
		page.on('request', request => { if (request.url().endsWith('/api/scm-operation')) identity = request.postDataJSON(); });
		await page.routeWebSocket('**/ws', route => {
			const upstream = route.connectToServer();
			route.onMessage(raw => { const msg = JSON.parse(String(raw)); if (msg.type === 'prompt') throw Error('No model calls'); if (msg.type === 'run_command') terminalCommands.push(msg); upstream.send(raw); });
			upstream.onMessage(raw => { const msg = JSON.parse(String(raw)); if (msg.type === 'snapshot') msg.state.piConfigured = true; route.send(JSON.stringify(msg)); if (msg.type === "scm_data" && msg.kind === "status" && msg.reqId > 0) route.send(JSON.stringify({ ...msg, reqId: -999 })); });
		});
		await page.goto(`http://127.0.0.1:${server.port}`); await page.locator('.view-switch button', { hasText: 'Git' }).click();
		await page.locator('.scm-worktrees summary').click().catch(async error => { console.error(await page.locator('body').innerText()); throw error; }); assert.equal(await page.locator('.scm-worktrees li').count(), 2);
		assert.match(await page.locator('.scm-worktrees').innerText(), /linked tree/);
		const switchBranch = async branch => { await page.locator('.scm-select').selectOption(branch); await page.getByRole('button', { name: lang === 'zh' ? '切换' : 'Switch', exact: true }).click(); };
		const done = () => page.locator('.scm-operation strong', { hasText: lang === 'zh' ? '已完成' : 'completed' }).waitFor();
		await switchBranch('feature'); await done(); await page.locator('.scm-branch-current', { hasText: 'feature' }).waitFor(); assert.equal(git('branch', '--show-current'), 'feature');
		await switchBranch('main'); await done(); await page.locator('.scm-branch-current', { hasText: 'main' }).waitFor();
		for (const name of (lang === 'zh' ? ['推送', '拉取'] : ['Push', 'Pull'])) { await page.getByRole('button', { name, exact: true }).click(); await done(); }
		assert(await page.locator('.view-switch button[aria-selected="true"]', { hasText: 'Git' }).isVisible()); assert.equal(terminalCommands.length, 0);
		const denied = await page.request.post(`http://127.0.0.1:${server.port}/api/scm-operation`, { data: { ...identity, cwd: root } }); assert.equal(denied.status(), 409);
		const wrongSession = await page.request.post(`http://127.0.0.1:${server.port}/api/scm-operation`, { data: { ...identity, conversationId: 'stale' } }); assert.equal(wrongSession.status(), 409);
		await switchBranch('linked'); await page.locator('.scm-operation[role="alert"]').waitFor(); assert.equal(git('branch', '--show-current'), 'main');
		await page.locator('.scm-operation button').click(); await page.locator('.view-switch button[aria-selected="true"]', { hasText: lang === 'zh' ? '终端' : 'Terminal' }).waitFor(); assert.equal(terminalCommands.length, 0, 'recovery never replays the operation');
		await page.close(); console.log(`PASS ${lang}: worktrees, switch/push/pull in SCM, failed switch, manual recovery, workspace/session admission`);
	}
} finally { await browser?.close(); await server?.stop(); rmSync(root, { recursive: true, force: true }); }
