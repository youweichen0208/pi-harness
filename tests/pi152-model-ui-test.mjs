/** Production UI regression for Pi 1.5.2 compatibility controls, code and diagrams. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'pi152-model-ui-')), agent = join(root, 'agent'); mkdirSync(agent);
const modelsPath = join(agent, 'models.json');
writeFileSync(modelsPath, JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture-only', compat: { supportsMessageThreads: true, futureField: { keep: true } }, models: [{ id: 'fixture', compat: { supportsMessageThreads: false, promptCacheKeyMode: 'disabled', requiresNonNullAssistantContent: false } }] } } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', cacheWarming: 'off' }));
const snippets = { dart: 'void main() { print("hello"); }', nix: '{ pkgs ? import <nixpkgs> {} }: pkgs.mkShell { name = "hello"; }', groovy: 'def greet = "hello"', gradle: 'plugins { id "java" }', javascript: 'const greeting = "hello";' };
const markdown = Object.entries(snippets).map(([language, code]) => `\n\`\`\`${language}\n${code}\n\`\`\`\n`).join('\n') + '\n```mermaid\npie title Cache\n "Read" : 70\n "Write" : 30\n```\n\n```mermaid\nflowchart LR\n A[Start] --> B[Done]\n classDef finished font-weight:bold,stroke-width:3px\n class B finished\n click B unsafeFixture\n```';
let browser, server;
try {
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: agent } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(() => { window.unsafeFixtureCalled = false; window.unsafeFixture = () => { window.unsafeFixtureCalled = true; }; });
	await page.routeWebSocket('**/ws', socket => {
		const upstream = socket.connectToServer(); socket.onMessage(raw => upstream.send(raw));
		upstream.onMessage(raw => {
			const message = JSON.parse(String(raw));
			if (message.type === 'snapshot') message.state = { ...message.state, isStreaming: false, messages: [{ id: 'fixture-user', role: 'user', content: [{ type: 'text', text: 'Show examples' }] }, { id: 'fixture-answer', role: 'assistant', content: [{ type: 'text', text: markdown }] }] };
			if (message.type !== 'snapshot_delta') socket.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.locator('.mermaid-svg svg').nth(1).waitFor({ timeout: 25000 });
	for (const language of Object.keys(snippets)) assert(await page.locator(`code.language-${language} [class*="hljs-"]`).count() > 0, `${language} fence highlights`);
	assert(await page.locator('.mermaid-svg .pieCircle').count() >= 2, 'pie diagram has slices');
	const finished = page.locator('.mermaid-svg .node.finished'); await finished.click();
	assert.equal(await page.evaluate(() => window.unsafeFixtureCalled), false, 'strict diagram cannot execute callbacks');
	assert(await finished.locator('[style*="font-weight:bold"], [style*="stroke-width:3px"]').count() > 0, 'diagram class style rendered');
	assert.equal(await page.locator('.mermaid-svg script, .mermaid-svg [onclick]').count(), 0);
	for (const theme of ['light', 'dark']) {
		await page.evaluate(theme => document.documentElement.dataset.appearance = theme, theme);
		await page.setViewportSize({ width: 375, height: 900 });
		await page.locator('.input-tools-left .dropdown > button.chip:visible').first().click();
		await page.locator('.model-cache-warming select').waitFor();
		assert.equal(await page.locator('.model-cache-warming select').inputValue(), 'off');
		const menuStyle = await page.locator('.dd-menu-model').evaluate(el => ({ opacity: getComputedStyle(el).opacity, color: getComputedStyle(el).color }));
		assert.equal(menuStyle.opacity, '1');
		await page.screenshot({ path: `/tmp/pi152-cache-picker-${theme}-375.png`, animations: 'disabled' });
		await page.keyboard.press('Escape');
		await page.locator('.usage-trigger:visible').click();
		await page.getByText('本会话预热费用', { exact: true }).waitFor();
		const usageBox = await page.locator('.usage-popover').boundingBox();
		assert(usageBox && usageBox.x >= 0 && usageBox.x + usageBox.width <= 375 && usageBox.y >= 0, 'usage detail remains within viewport');
		await page.screenshot({ path: `/tmp/pi152-cache-usage-${theme}-375.png`, animations: 'disabled' });
		await page.keyboard.press('Escape');
	}
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator('.chip-model:visible').first().click();
	await page.locator('.dd-refresh').filter({ hasText: '管理模型' }).click();
	await page.locator('.provider-row').filter({ hasText: 'fixture' }).getByRole('button', { name: '编辑', exact: true }).click();
	const providerCompat = page.locator('.provider-form > .model-compat'), modelCompat = page.locator('.model-row .model-compat');
	assert.equal(await providerCompat.getAttribute('open'), null);
	assert.equal(await modelCompat.getAttribute('open'), null);
	await providerCompat.locator('summary').focus(); await page.keyboard.press('Enter');
	await modelCompat.locator('summary').click();
	assert.equal(await providerCompat.getByLabel('Anthropic 消息线程').inputValue(), 'true');
	assert.equal(await modelCompat.getByLabel('Anthropic 消息线程').inputValue(), 'false');
	assert.equal(await modelCompat.getByLabel('工具历史携带空工具列表').inputValue(), '');
	await modelCompat.getByLabel('Anthropic 消息线程').selectOption('');
	await modelCompat.getByLabel('助手空内容使用空字符串').selectOption('true');
	await providerCompat.getByLabel('提示词缓存键').selectOption('enabled');
	for (const theme of ['light', 'dark']) for (const width of [375, 1440]) {
		await page.evaluate(theme => document.documentElement.dataset.appearance = theme, theme);
		await page.setViewportSize({ width, height: 1000 });
		assert(await page.locator('.model-modal-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
		await modelCompat.scrollIntoViewIfNeeded();
		await page.screenshot({ path: `/tmp/pi152-model-compat-${theme}-${width}.png` });
	}
	await page.getByRole('button', { name: '保存', exact: true }).click();
	await page.waitForTimeout(300);
	const config = JSON.parse(readFileSync(modelsPath)).providers.fixture;
	assert.deepEqual(config.compat, { supportsMessageThreads: true, promptCacheKeyMode: 'enabled', futureField: { keep: true } });
	assert.deepEqual(config.models[0].compat, { promptCacheKeyMode: 'disabled', requiresNonNullAssistantContent: true });
	assert.equal(config.apiKey, 'fixture-only');
	await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en')); await page.reload();
	await page.locator('.chip-model:visible').first().click();
	await page.locator('.dd-refresh').filter({ hasText: 'Manage models' }).click();
	await page.locator('.provider-row').filter({ hasText: 'fixture' }).getByRole('button', { name: 'Edit', exact: true }).click();
	await page.locator('.model-row .model-compat summary').click();
	assert.equal(await page.locator('.model-row').getByLabel('Anthropic message threads').inputValue(), '');
	assert.equal(await page.locator('.model-row').getByLabel('Use empty strings for assistant content').inputValue(), 'true');
	assert.deepEqual(errors, []);
	console.log('PASS compatibility disclosures, explicit false/inherit/save/reopen, zh/en, 375px light/dark, all code grammars, Mermaid pie/styles/strict callbacks');
} finally { await browser?.close(); await server?.stop(); rmSync(root, { recursive: true, force: true }); }
