/** OMP MCP UI with actual HTTP routes and native connections; optional packaged Electron executable. */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, _electron as electron } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-mcp-ui-'))), cwd = join(root, 'workspace'), data = join(root, 'data'), agent = join(data, 'omp/agent');
mkdirSync(cwd); mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', apiKey: 'FIXTURE_MODEL_KEY', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'fixture' }] } } }));
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false } }));
const calls = [], importHeaders = [];
let oauthBase, protectedAuthenticatedCalls = 0, diagnosticFailure = false;
const mcp = createServer(async (req, res) => {
	const url = new URL(req.url, oauthBase), json = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
	if (diagnosticFailure && url.pathname === '/mcp') { res.writeHead(403); res.end('UNLABELLED_DIAGNOSTIC_SECRET'); return; }
	if (url.pathname.includes('.well-known/oauth-protected-resource')) return json(200, { resource: `${oauthBase}/protected`, authorization_servers: [oauthBase] });
	if (url.pathname.includes('.well-known/')) return json(200, { issuer: oauthBase, authorization_endpoint: `${oauthBase}/authorize`, token_endpoint: `${oauthBase}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], client_id: 'ui-client' });
	if (url.pathname === '/token') { for await (const chunk of req) {} return json(200, { access_token: 'UI_ACCESS_SECRET', refresh_token: 'UI_REFRESH_SECRET', token_type: 'Bearer', expires_in: 3600 }); }
	if (url.pathname === '/protected' && req.headers.authorization !== 'Bearer UI_ACCESS_SECRET') {
		res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${oauthBase}/.well-known/oauth-protected-resource"`); return json(401, { error: 'unauthorized' });
	}
	if (url.pathname === '/protected') protectedAuthenticatedCalls++;
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	let text = ''; for await (const chunk of req) text += chunk;
	const rpc = JSON.parse(text); calls.push(rpc.method);
	if (req.headers["x-import-key"]) importHeaders.push(req.headers["x-import-key"]);
	if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
	const result = rpc.method === 'initialize' ? { protocolVersion: rpc.params.protocolVersion, serverInfo: { name: 'ui-fixture', version: '1' }, capabilities: { tools: {} } }
		: rpc.method === 'tools/list' ? { tools: [{ name: 'fixture_echo', description: 'Fixture echo', inputSchema: { type: 'object', properties: {} } }] } : {};
	res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
});
let browser, app, harness, page, socket;
// Electron owns beforeunload through will-prevent-unload and a native dialog.
// Answer that dialog at its OS boundary; the renderer's dirty guard still runs.
const cancelReload = async () => {
	if (app) {
		// A listener also suppresses Playwright's default CDP auto-dismissal.
		// Electron closes this notification itself after the native response.
		const observedDialogs = [];
		const observeDialog = dialog => observedDialogs.push(dialog.type());
		page.on('dialog', observeDialog);
		await app.evaluate(({ dialog }) => {
			globalThis.ompMcpUnloadTest = { original: dialog.showMessageBoxSync, prompts: [] };
			dialog.showMessageBoxSync = (_window, options) => {
				globalThis.ompMcpUnloadTest.prompts.push(options);
				return options.cancelId;
			};
		});
		let prompts;
		try { await page.reload({ timeout: 10000 }).catch(() => {}); }
		finally {
			page.off('dialog', observeDialog);
			prompts = await app.evaluate(({ dialog }) => {
				const state = globalThis.ompMcpUnloadTest;
				dialog.showMessageBoxSync = state.original;
				delete globalThis.ompMcpUnloadTest;
				return state.prompts;
			});
		}
		assert.equal(prompts.length, 1, 'actual reload reaches the native unsaved-changes confirmation');
		assert.deepEqual(observedDialogs, ['beforeunload']);
		assert.equal(prompts[0].type, 'warning');
		assert.equal(prompts[0].cancelId, 0);
		assert.equal(prompts[0].buttons.length, 2);
	} else {
		const pendingDialog = page.waitForEvent('dialog');
		const reload = page.reload({ timeout: 10000 }).catch(() => {});
		const dialog = await pendingDialog;
		assert.equal(dialog.type(), 'beforeunload');
		await dialog.dismiss();
		await reload;
	}
};
try {
	const port = await listenIsolated(mcp); oauthBase = `http://127.0.0.1:${port}`;
	if (process.argv[2]) {
		app = await electron.launch({ executablePath: resolve(process.argv[2]), args: [`--user-data-dir=${join(root, 'profile')}`], env: testEnv({ PI_WEB_DATA_DIR: data, PI_WEB_CWD: cwd, HARNESS_TEST_MCP_IMPORT_KEY: "IMPORT_EXPANDED" }) });
		for (let i = 0; i < 250; i++) { page = app.windows().find(window => window.url().startsWith('http://127.0.0.1:')); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)); }
		assert(page); await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.setContentSize(1440, 1000); });
		await page.setViewportSize({ width: 1440, height: 1000 });
	} else {
		harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, HARNESS_TEST_MCP_IMPORT_KEY: "IMPORT_EXPANDED" } });
		browser = await chromium.launch({ executablePath: CHROME_PATH }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		await page.goto(`http://127.0.0.1:${harness.port}`);
	}
	page.setDefaultTimeout(40000);
	const errors = [], requests = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('request', request => { if (new URL(request.url()).pathname === '/api/omp-mcp') requests.push({ url: request.url(), body: request.postDataJSON() }); });
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.getByRole('button', { name: '设置', exact: true }).and(page.locator(':visible')).first().click();
	await page.getByText('所有设置', { exact: true }).click();
	await page.getByRole('button', { name: 'OMP 工具', exact: true }).click();
	const panel = page.getByRole('region', { name: '原生 MCP', exact: true });
	await panel.locator('.omp-mcp-editor > summary').click();
	const editor = panel.getByRole('textbox', { name: 'MCP 配置 JSON', exact: true });
	const doc = { mcpServers: { fixture: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer UI_SECRET' }, future: { opaque: 'UI_UNKNOWN_SECRET' } } } };
	await editor.fill(JSON.stringify(doc, null, 2));
	assert(await panel.getByRole('button', { name: '重载当前会话 MCP' }).isDisabled());
	await panel.getByRole('button', { name: '保存 MCP 配置' }).click();
	await panel.getByText('配置已变更。重载 MCP 或新建会话后生效。').waitFor();
	await page.waitForFunction(() => document.querySelector('.omp-mcp-panel')?.dataset.dirty === 'false');
	assert(!((await editor.inputValue()).includes('UI_SECRET')));
	assert.equal(JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers.fixture.headers.Authorization, 'Bearer UI_SECRET');
	assert.equal(calls.length, 0, 'saving alone does not launch the server');
	// Import drafts share native CAS and preserve existing masked credentials.
	await panel.getByRole('button', { name: '导入 MCP 配置', exact: true }).click();
	const importer = panel.getByRole('form', { name: '导入 MCP 配置', exact: true });
	const importInput = importer.getByLabel('待导入的 JSON', { exact: true });
	const importedText = JSON.stringify({ mcp: { servers: { 'Imported local': { type: 'local', command: ['MUST_NOT_EXECUTE_IMPORTED_SERVER', '{env:ARG}'], environment: { SECRET: 'IMPORT_SECRET', REF: '{env:KEY}' }, disabled: true }, 'Imported remote': { type: 'remote', url: 'http://127.0.0.1:1/mcp', disabled: true } } } });
	await importInput.fill('{"mcpServers":{"a":{"command":"IMPORT_SECRET');
	await importer.getByRole('button', { name: '预览导入', exact: true }).click();
	assert(!(await panel.getByRole('alert').innerText()).includes('IMPORT_SECRET'));
	assert(await importer.getByRole('button', { name: '保存导入', exact: true }).isDisabled());
	await importInput.fill(importedText);
	await importer.getByRole('button', { name: '预览导入', exact: true }).click();
	await importer.getByRole('status').getByText('Imported local', { exact: true }).waitFor();
	assert(!(await importer.getByRole('status').innerText()).includes('IMPORT_SECRET'));
	assert(await editor.isDisabled()); assert(await panel.getByRole('button', { name: '重载当前会话 MCP' }).isDisabled());
	page.once('dialog', dialog => dialog.dismiss()); await panel.getByRole('combobox').first().selectOption('project');
	assert.equal(await panel.getByRole('combobox').first().inputValue(), 'global');
	page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Extensions', exact: true }).click();
	await new Promise(resolve => setTimeout(resolve, 3200)); assert.equal(await importInput.inputValue(), importedText);
	await cancelReload();
	assert.equal(await importInput.inputValue(), importedText, 'canceling actual reload preserves the import draft');
	await page.setViewportSize({ width: 390, height: 844 }); await importer.scrollIntoViewIfNeeded();
	assert(await importer.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
	for (const control of await importer.locator('textarea,button').all()) assert((await control.boundingBox()).height >= 44);
	mkdirSync('tests/scratch', { recursive: true });
	for (const appearance of ['light', 'dark']) { await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance); await page.screenshot({ path: `tests/scratch/omp-mcp-import-${appearance}.png` }); }
	await page.setViewportSize({ width: 1440, height: 1000 });
	const importExternal = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')); importExternal.mcpServers.fixture.timeout = 4321;
	writeFileSync(join(agent, 'mcp.json'), JSON.stringify(importExternal));
	await importer.getByRole('button', { name: '保存导入', exact: true }).click();
	await panel.getByText('MCP configuration changed; reload before saving', { exact: true }).waitFor();
	assert.equal(await importInput.inputValue(), importedText);
	assert(!JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers['Imported local']);
	page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '重新读取配置', exact: true }).click();
	await importer.waitFor({ state: 'detached' });
	await panel.getByRole('button', { name: '导入 MCP 配置', exact: true }).click(); await importInput.fill(importedText);
	await importer.getByRole('button', { name: '预览导入', exact: true }).click();
	await importer.getByRole('button', { name: '保存导入', exact: true }).click(); await importer.waitFor({ state: 'detached' });
	await page.waitForFunction(() => document.activeElement?.textContent === '导入 MCP 配置');
	const importedConfig = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8'));
	assert.deepEqual(importedConfig.mcpServers['Imported local'], { type: 'stdio', command: 'MUST_NOT_EXECUTE_IMPORTED_SERVER', args: ['${ARG}'], env: { SECRET: 'IMPORT_SECRET', REF: '${KEY}' }, enabled: false });
	assert.equal(importedConfig.mcpServers['Imported remote'].enabled, false);
	assert.equal(importedConfig.mcpServers.fixture.headers.Authorization, 'Bearer UI_SECRET');
	assert.equal(importedConfig.mcpServers.fixture.future.opaque, 'UI_UNKNOWN_SECRET'); assert.equal(importedConfig.mcpServers.fixture.timeout, 4321);
	assert.equal(calls.length, 0, 'import saves without connecting'); assert(!(await panel.innerText()).includes('IMPORT_SECRET')); assert(!(await editor.inputValue()).includes('IMPORT_SECRET'));
	await panel.getByRole('button', { name: '导入 MCP 配置', exact: true }).click(); await importInput.fill(importedText);
	await importer.getByRole('button', { name: '预览导入', exact: true }).click();
	await panel.getByText('导入名称与本范围已有服务或启停规则冲突。请修改导入名称，或编辑已有配置；未覆盖任何内容。', { exact: true }).waitFor();
	assert(await importer.getByRole('button', { name: '保存导入', exact: true }).isDisabled());
	await importer.getByRole('button', { name: '取消', exact: true }).click();
	// Per-server editing uses the same native CAS writer and never exposes stored values.
	await panel.getByRole('button', { name: '编辑服务 fixture', exact: true }).click();
	const form = panel.getByRole('form', { name: 'MCP 服务表单', exact: true });
	assert.equal(await form.getByLabel('服务地址', { exact: true }).inputValue(), '••••••••');
	assert(!(await form.getByLabel('HTTP headers（JSON 对象）', { exact: true }).inputValue()).includes('UI_SECRET'));
	await form.getByLabel('超时（毫秒，留空使用原生默认）', { exact: true }).fill('1234');
	page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Extensions', exact: true }).click();
	assert.equal(await form.getByLabel('超时（毫秒，留空使用原生默认）', { exact: true }).inputValue(), '1234');
	await new Promise(resolve => setTimeout(resolve, 3200));
	assert.equal(await form.getByLabel('超时（毫秒，留空使用原生默认）', { exact: true }).inputValue(), '1234', 'polling preserves form edits');
	await cancelReload();
	assert.equal(await form.getByLabel('超时（毫秒，留空使用原生默认）', { exact: true }).inputValue(), '1234');

	const external = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')); external.mcpServers.fixture.timeout = 5678;
	writeFileSync(join(agent, 'mcp.json'), JSON.stringify(external));
	await form.getByRole('button', { name: '保存服务', exact: true }).click();
	await panel.getByText('MCP configuration changed; reload before saving', { exact: true }).waitFor();
	assert.equal(await form.getByLabel('超时（毫秒，留空使用原生默认）', { exact: true }).inputValue(), '1234');
	assert.equal(JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers.fixture.timeout, 5678);
	page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '重新读取配置', exact: true }).click();
	await form.waitFor({ state: 'detached' });
	await panel.getByRole('button', { name: '编辑服务 fixture', exact: true }).click();
	await form.getByLabel('超时（毫秒，留空使用原生默认）', { exact: true }).fill('0');
	await form.getByRole('button', { name: '保存服务', exact: true }).click(); await form.waitFor({ state: 'detached' });
	const edited = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers.fixture;
	assert.equal(edited.timeout, 0); assert.equal(edited.headers.Authorization, 'Bearer UI_SECRET'); assert.equal(edited.future.opaque, 'UI_UNKNOWN_SECRET');
	assert.equal(calls.length, 0, 'form save alone does not start MCP');
	await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '编辑服务 fixture');
	await panel.getByRole('button', { name: '新建服务', exact: true }).click();
	await form.getByLabel('服务名称', { exact: true }).fill('Local env fixture');
	await form.getByLabel('命令', { exact: true }).fill('MUST_NOT_EXECUTE_DISABLED_FIXTURE');
	await form.getByLabel('参数（JSON 数组）', { exact: true }).fill('["hello world", "中文"]');
	await form.getByLabel('环境变量（JSON 对象）', { exact: true }).fill('{"SECRET":"FORM_SECRET');
	await form.getByRole('button', { name: '保存服务', exact: true }).click();
	await panel.getByRole('alert').waitFor(); assert(!(await panel.getByRole('alert').textContent()).includes('FORM_SECRET'));
	await form.getByLabel('环境变量（JSON 对象）', { exact: true }).fill('{"SECRET":"FORM_SECRET"}');
	await form.getByLabel('启用', { exact: true }).selectOption('false');
	await page.setViewportSize({ width: 390, height: 844 }); await form.scrollIntoViewIfNeeded();
	assert(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
	for (const element of await form.locator('input,select,textarea,button').all()) assert((await element.boundingBox()).height >= 44);
	mkdirSync('tests/scratch', { recursive: true });
	for (const appearance of ['light', 'dark']) { await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance); await page.screenshot({ path: `tests/scratch/omp-mcp-form-${appearance}.png` }); }
	await page.setViewportSize({ width: 1440, height: 1000 });
	await form.getByRole('button', { name: '保存服务', exact: true }).click(); await form.waitFor({ state: 'detached' });
	const localConfig = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8'));
	assert.equal(localConfig.mcpServers['Local env fixture'].env.SECRET, 'FORM_SECRET'); assert.equal(localConfig.mcpServers['Local env fixture'].enabled, false);
	assert(localConfig.disabledServers.includes('Local env fixture'));
	assert(!(await editor.inputValue()).includes('FORM_SECRET'));
	await panel.getByRole('button', { name: '编辑服务 Local env fixture', exact: true }).click();
	assert.equal(await form.getByLabel('连接方式', { exact: true }).inputValue(), 'stdio');
	assert.equal(await form.getByLabel('命令', { exact: true }).inputValue(), '••••••••');
	assert.equal(await form.getByLabel('启用', { exact: true }).inputValue(), 'false');
	await form.getByRole('button', { name: '取消', exact: true }).click();

	await panel.getByRole('button', { name: '新建服务', exact: true }).click();
	await form.getByLabel('服务名称', { exact: true }).fill('fixture'); await form.getByLabel('命令', { exact: true }).fill('unused');
	await form.getByRole('button', { name: '保存服务', exact: true }).click(); await panel.getByText('本范围已存在同名服务，请使用编辑。', { exact: true }).waitFor();
	await form.getByRole('button', { name: '取消', exact: true }).click();
	page.once('dialog', dialog => dialog.dismiss()); await panel.getByRole('button', { name: '删除服务 Local env fixture', exact: true }).click();
	assert(JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers['Local env fixture']);
	page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '删除服务 Local env fixture', exact: true }).click();
	await panel.getByRole('button', { name: '删除服务 Local env fixture', exact: true }).waitFor({ state: 'detached' });
	assert(!JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers['Local env fixture']);
	// Global enabled rules are native and must not be mistaken for connection state.
	for (const enabled of ['false', 'true', '']) {
		await panel.getByRole('button', { name: '编辑服务 fixture', exact: true }).click();
		await form.getByLabel('启用', { exact: true }).selectOption(enabled);
		await form.getByRole('button', { name: '保存服务', exact: true }).click(); await form.waitFor({ state: 'detached' });
		const persisted = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8'));
		assert.equal(persisted.disabledServers?.includes('fixture') ?? false, enabled === 'false');
		assert.equal(persisted.enabledServers?.includes('fixture') ?? false, enabled === 'true');
		await panel.getByRole('button', { name: '重载当前会话 MCP' }).click();
		const liveFixture = panel.locator('.omp-mcp-server').filter({ has: page.getByText('fixture', { exact: true }) });
		if (enabled === 'false') await liveFixture.waitFor({ state: 'detached' });
		else await liveFixture.getByText('已连接', { exact: true }).waitFor();

	}

	await panel.getByRole('button', { name: '重载当前会话 MCP' }).click();
	const server = panel.locator('.omp-mcp-server', { hasText: 'fixture' });
	await server.getByText('已连接', { exact: true }).waitFor();
	await server.getByText('1 个工具', { exact: true }).click(); await server.getByText('fixture_echo', { exact: true }).waitFor();
	diagnosticFailure = true;
	await server.getByRole('button', { name: '重新连接', exact: true }).click();
	await server.locator('.omp-mcp-failure').filter({ hasText: 'HTTP 403' }).waitFor();
	const diagnostics = panel.locator('.omp-mcp-diagnostics');
	await diagnostics.locator('summary').click();
	await diagnostics.getByText('HTTP 请求失败，请检查地址、权限和登录状态。 (HTTP 403)', { exact: true }).waitFor();
	assert(!(await panel.innerText()).includes('UNLABELLED_DIAGNOSTIC_SECRET'));
	await page.setViewportSize({ width: 390, height: 844 }); await diagnostics.scrollIntoViewIfNeeded();
	assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
	mkdirSync('tests/scratch', { recursive: true });
	for (const appearance of ['light', 'dark']) { await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance); await page.screenshot({ animations: 'disabled', path: `tests/scratch/omp-mcp-diagnostics-${appearance}.png` }); }
	diagnosticFailure = false;
	await server.getByRole('button', { name: '重新连接', exact: true }).click();
	await server.getByText('已连接', { exact: true }).waitFor();
	assert.equal(await server.locator('.omp-mcp-failure').count(), 0);
	assert((await diagnostics.innerText()).includes('HTTP 403'), 'recovery retains failure evidence');
	await diagnostics.locator('summary').click(); await page.setViewportSize({ width: 1440, height: 1000 });
	await page.waitForFunction(() => ![...document.querySelectorAll('.omp-mcp-actions button')].find(button => button.textContent === '重载当前会话 MCP')?.disabled);
	const withOAuth = JSON.parse(await editor.inputValue());
	withOAuth.mcpServers.oauth = { type: 'http', url: `${oauthBase}/protected`, oauth: { clientId: 'ui-client', callbackPort: 0 } };
	await editor.fill(JSON.stringify(withOAuth)); await panel.getByRole('button', { name: '保存 MCP 配置' }).click();
	await page.waitForFunction(() => document.querySelector('.omp-mcp-panel')?.dataset.dirty === 'false');
	await panel.getByRole('button', { name: '重载当前会话 MCP' }).click();
	const oauthServer = panel.locator('.omp-mcp-server').filter({ has: page.getByText('oauth', { exact: true }) });
	await oauthServer.getByRole('button', { name: 'OAuth 登录', exact: true }).click();
	await panel.getByRole('link', { name: '打开授权页面' }).waitFor();
	assert(await panel.getByRole('button', { name: '重载当前会话 MCP' }).isDisabled());
	await panel.getByRole('button', { name: '取消', exact: true }).click();
	await panel.getByText('oauth: 授权流程已取消；已保存的凭据不会回滚。', { exact: true }).waitFor();
	await oauthServer.getByRole('button', { name: 'OAuth 登录', exact: true }).click();
	const changedLink = panel.getByRole('link', { name: '打开授权页面' }); await changedLink.waitFor();
	const changedAuthorization = new URL(await changedLink.getAttribute('href'));
	const changedCallback = new URL(changedAuthorization.searchParams.get('redirect_uri'));
	changedCallback.searchParams.set('code', 'CONFIG_CHANGE_CODE'); changedCallback.searchParams.set('state', changedAuthorization.searchParams.get('state'));
	const changedConfig = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')); changedConfig.mcpServers.oauth.enabled = false;
	writeFileSync(join(agent, 'mcp.json'), JSON.stringify(changedConfig));
	await panel.getByLabel('授权码或完整回调地址', { exact: true }).fill(changedCallback.href);
	await panel.getByRole('button', { name: '提交授权', exact: true }).click();
	await panel.getByText('oauth: 授权期间服务配置已变化或无法核对，未自动重新连接。登录凭据可能已保存；请检查配置并重新加载 MCP。', { exact: true }).waitFor();
	assert.equal(protectedAuthenticatedCalls, 0, 'changed configuration prevents automatic obsolete reconnect');
	assert.equal(JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers.oauth.enabled, false);
	await page.setViewportSize({ width: 390, height: 844 }); await panel.locator('.omp-mcp-auth').scrollIntoViewIfNeeded();
	assert(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
	mkdirSync('tests/scratch', { recursive: true }); await page.screenshot({ path: 'tests/scratch/omp-mcp-auth-changed.png' });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await panel.getByRole('button', { name: '重新读取配置', exact: true }).click();
	await page.waitForFunction(() => { const input = document.querySelector('.omp-mcp-editor textarea'); return input && !input.disabled && JSON.parse(input.value).mcpServers.oauth.enabled === false; });
	const resumeConfig = JSON.parse(await editor.inputValue()); delete resumeConfig.mcpServers.oauth.enabled;
	await editor.fill(JSON.stringify(resumeConfig)); await panel.getByRole('button', { name: '保存 MCP 配置' }).click();
	await page.waitForFunction(() => document.querySelector('.omp-mcp-panel')?.dataset.dirty === 'false');
	await panel.getByRole('button', { name: '重载当前会话 MCP' }).click();
	await oauthServer.getByText('已连接', { exact: true }).waitFor();
	await oauthServer.getByRole('button', { name: 'OAuth 登录', exact: true }).click();
	const link = panel.getByRole('link', { name: '打开授权页面' }); await link.waitFor();
	mkdirSync('tests/scratch', { recursive: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await panel.scrollIntoViewIfNeeded();
	assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'OAuth controls fit a narrow panel');
	for (const appearance of ['light', 'dark']) { await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance); await page.screenshot({ animations: "disabled", path: `tests/scratch/omp-mcp-auth-${appearance}.png` }); }
	await page.setViewportSize({ width: 1440, height: 1000 });
	const authorization = new URL(await link.getAttribute('href'));
	assert.equal(authorization.origin, oauthBase);
	const callback = new URL(authorization.searchParams.get('redirect_uri'));
	callback.searchParams.set('code', 'UI_CODE_SECRET'); callback.searchParams.set('state', authorization.searchParams.get('state'));
	await panel.getByLabel('授权码或完整回调地址', { exact: true }).fill(callback.href);
	await panel.getByRole('button', { name: '提交授权', exact: true }).click();
	await oauthServer.getByText('已保存 OAuth 凭据', { exact: true }).waitFor();
	await oauthServer.getByText('已连接', { exact: true }).waitFor();
	assert(!(await panel.textContent()).includes('UI_ACCESS_SECRET'));
	page.once('dialog', dialog => dialog.accept());
	await oauthServer.getByRole('button', { name: '清除 OAuth 登录', exact: true }).click();
	await oauthServer.waitFor({ state: 'detached' });
	await panel.getByText('oauth: OAuth 凭据已清除，当前会话已断开该服务。重载 MCP 后可重新登录。', { exact: true }).waitFor();
	const withoutOAuth = JSON.parse(await editor.inputValue()); delete withoutOAuth.mcpServers.oauth;
	await editor.fill(JSON.stringify(withoutOAuth)); await panel.getByRole('button', { name: '保存 MCP 配置' }).click();
	await page.waitForFunction(() => document.querySelector('.omp-mcp-panel')?.dataset.dirty === 'false');
	await panel.getByRole('button', { name: '重载当前会话 MCP' }).click();
	await oauthServer.waitFor({ state: 'detached' });
	await editor.fill('{'); await panel.getByRole('button', { name: '保存 MCP 配置' }).click();
	await panel.getByText('请输入有效的 JSON 配置。').waitFor();
	await new Promise(resolve => setTimeout(resolve, 3200)); assert.equal(await editor.inputValue(), '{', 'status polling cannot replace a draft');
	page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Extensions', exact: true }).click();
	assert.equal(await editor.inputValue(), '{');
	page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '重新读取配置', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.omp-mcp-panel')?.dataset.dirty === 'false');
	const owner = requests.find(request => request.body.action === 'get'); assert(owner);
	const invalidOwner = await fetch(owner.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(page.url()).origin }, body: JSON.stringify({ ...owner.body, action: 'reload', conversationId: 'wrong' }) }); assert.equal(invalidOwner.status, 409);
	const invalidOrigin = await fetch(owner.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' }, body: JSON.stringify({ ...owner.body, action: 'reload' }) }); assert.equal(invalidOrigin.status, 403);
	const saved = JSON.parse(await editor.inputValue()); saved.mcpServers.fixture.timeout = 1234;
	const disk = JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')); disk.mcpServers.fixture.timeout = 5678; writeFileSync(join(agent, 'mcp.json'), JSON.stringify(disk));
	await editor.fill(JSON.stringify(saved)); await panel.getByRole('button', { name: '保存 MCP 配置' }).click();
	await panel.getByText('MCP configuration changed; reload before saving', { exact: true }).waitFor();
	assert.equal(JSON.parse(readFileSync(join(agent, 'mcp.json'), 'utf8')).mcpServers.fixture.timeout, 5678);
	page.once('dialog', dialog => dialog.accept()); await panel.getByRole('combobox', { name: '配置范围' }).selectOption('project');
	await page.waitForFunction(() => document.querySelector('.omp-mcp-path')?.textContent?.includes('/.omp/mcp.json') || document.querySelector('.omp-mcp-path')?.textContent?.includes('\\.omp\\mcp.json'));
	const globalBeforeProjectImport = readFileSync(join(agent, 'mcp.json'), 'utf8');
	await panel.getByRole('button', { name: '导入 MCP 配置', exact: true }).click();
	await importInput.fill(JSON.stringify({ servers: { fixture: { type: 'http', url: `${oauthBase}/mcp`, headers: { 'X-Import-Key': '${env:HARNESS_TEST_MCP_IMPORT_KEY}' } } } }));
	await importer.getByRole('button', { name: '预览导入', exact: true }).click();
	await importer.getByRole('button', { name: '保存导入', exact: true }).click(); await importer.waitFor({ state: 'detached' });
	assert.equal(readFileSync(join(agent, 'mcp.json'), 'utf8'), globalBeforeProjectImport, 'project import preserves global configuration');
	assert.equal(JSON.parse(readFileSync(join(cwd, '.omp', 'mcp.json'), 'utf8')).mcpServers.fixture.headers['X-Import-Key'], '${HARNESS_TEST_MCP_IMPORT_KEY}');
	assert.deepEqual(importHeaders, [], 'project import does not connect before reload');
	const reloadedImport = page.waitForResponse(response => new URL(response.url()).pathname === '/api/omp-mcp' && response.request().postDataJSON()?.action === 'reload');
	await panel.getByRole('button', { name: '重载当前会话 MCP' }).click();
	const reloadResponse = await reloadedImport; assert.equal(reloadResponse.status(), 200); await reloadResponse.finished();
	await panel.locator('.omp-mcp-server').filter({ has: page.getByText('fixture', { exact: true }) }).getByText('已连接', { exact: true }).waitFor();
	assert.deepEqual([...new Set(importHeaders)], ['IMPORT_EXPANDED'], 'native OMP expands the converted variable on its host');
	await editor.fill(JSON.stringify({ mcpServers: { fixture: { ...doc.mcpServers.fixture, enabled: false } } }, null, 2));
	await panel.getByRole('button', { name: '保存 MCP 配置' }).click();
	await page.waitForFunction(() => document.querySelector('.omp-mcp-panel')?.dataset.dirty === 'false');
	await panel.getByRole('button', { name: '重载当前会话 MCP' }).click();
	await panel.locator('.omp-mcp-server').waitFor({ state: 'detached' });
	await page.setViewportSize({ width: 390, height: 844 });
	await panel.scrollIntoViewIfNeeded();
	assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
	mkdirSync('tests/scratch', { recursive: true });
	for (const appearance of ['light', 'dark']) { await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance); await page.screenshot({ animations: "disabled", path: `tests/scratch/omp-mcp-${appearance}.png` }); }
	// A real reload uses the English catalogue; labels remain stable with masked textarea content.
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en')); await page.reload();
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.getByRole('button', { name: 'Settings', exact: true }).and(page.locator(':visible')).first().click();
	await page.getByText('All settings', { exact: true }).click();
	await page.getByRole('button', { name: 'OMP tools', exact: true }).click();
	const english = page.getByRole('region', { name: 'Native MCP', exact: true });
	await english.getByRole('button', { name: 'Edit server fixture', exact: true }).click();
	const englishForm = english.getByRole('form', { name: 'MCP server form', exact: true });
	assert.equal(await englishForm.getByLabel('Server URL', { exact: true }).inputValue(), '••••••••');
	assert((await englishForm.getByLabel('HTTP headers (JSON object)', { exact: true }).inputValue()).includes('••••••••'));
	await page.setViewportSize({ width: 390, height: 844 }); await englishForm.scrollIntoViewIfNeeded();
	assert(await englishForm.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
	await page.screenshot({ path: 'tests/scratch/omp-mcp-form-en.png' });
	await englishForm.getByRole('button', { name: 'Cancel', exact: true }).click();
	await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Edit server fixture');
	await english.getByRole('button', { name: 'Import MCP configuration', exact: true }).click();
	const englishImport = english.getByRole('form', { name: 'Import MCP configuration', exact: true });
	await englishImport.getByLabel('JSON to import', { exact: true }).fill(JSON.stringify({ servers: { 'English preview': { type: 'http', url: 'https://example.invalid', headers: { Authorization: 'Bearer ${env:KEY}' } } } }));
	await englishImport.getByRole('button', { name: 'Preview import', exact: true }).click();
	await englishImport.getByRole('status').getByText('English preview', { exact: true }).waitFor();
	assert(await englishImport.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
	await englishImport.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'tests/scratch/omp-mcp-import-en.png' });
	await englishImport.getByRole('button', { name: 'Cancel', exact: true }).click();
	await page.waitForFunction(() => document.activeElement?.textContent === 'Import MCP configuration');
	const englishDiagnostics = english.locator('.omp-mcp-diagnostics');
	await englishDiagnostics.getByText('Connection diagnostics', { exact: true }).click();
	await englishDiagnostics.getByText('HTTP request failed. Check the endpoint, permissions and sign-in status. (HTTP 403)', { exact: true }).waitFor();
	await englishDiagnostics.scrollIntoViewIfNeeded();
	assert(await englishDiagnostics.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
	await page.screenshot({ path: 'tests/scratch/omp-mcp-diagnostics-en.png' });
	const socketUrl = new URL(owner.url); socketUrl.protocol = 'ws:'; socketUrl.pathname = '/ws';
	socket = new WebSocket(socketUrl);
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
	const ready = new Promise(resolve => socket.on('message', raw => { if (JSON.parse(raw).type === 'ready') resolve(); }));
	socket.send(JSON.stringify({ type: 'hello', clientId: owner.body.clientId })); await ready;
	socket.send(JSON.stringify({ type: 'abort' }));
	const status = async () => (await fetch(owner.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(page.url()).origin }, body: JSON.stringify({ ...owner.body, action: 'status' }) })).json();
	let stopped = false;
	for (let i = 0; i < 100; i++) { if ((await status()).available === false) { stopped = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
	assert(stopped, 'stopped worker becomes unavailable');
	await new Promise(resolve => setTimeout(resolve, 3500));
	assert.equal((await status()).available, false, 'UI status polling cannot reopen the worker');
	assert.equal(await english.locator('.omp-mcp-diagnostics').count(), 0, 'stopped worker diagnostics are not presented as live');
	assert.deepEqual(errors, []);
	console.log('PASS OMP MCP UI: atomic import/conversion/CAS/no-autostart and native per-server add/edit/enable/delete, masked/unknown fields, real reload, CAS/draft/focus, narrow bilingual forms, OAuth login/cancel/manual input/logout, ownership/Origin and stopped-worker isolation');
} catch (error) { console.error(error); if (page) await page.screenshot({ animations: "disabled", path: 'tests/scratch/omp-mcp-failure.png', timeout: 3000 }).catch(() => {}); throw error; }
finally {
	socket?.terminate();
	await browser?.close();
	if (app) { await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {}); await app.close(); }
	await harness?.stop(); mcp.closeAllConnections(); await new Promise(resolve => mcp.close(resolve)); rmSync(root, { recursive: true, force: true });
}
