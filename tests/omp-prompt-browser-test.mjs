/** Native OMP prompt settings in the browser or an actual packaged Electron app. */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, _electron as electron } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-prompt-ui-'))), cwd = join(root, 'workspace'), data = join(root, 'data'), agent = join(data, 'omp/agent');
mkdirSync(cwd); mkdirSync(agent, { recursive: true }); mkdirSync('tests/scratch', { recursive: true });
writeFileSync(join(cwd, 'AGENTS.md'), 'UI_CONTEXT_MARKER');
writeFileSync(join(agent, 'SYSTEM.md'), 'UI_GLOBAL_MARKER');
writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', apiKey: 'FIXTURE_MODEL_KEY', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'fixture' }] } } }));
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
let browser, app, harness, page, socket;
try {
	if (process.argv[2]) {
		app = await electron.launch({ executablePath: resolve(process.argv[2]), args: [`--user-data-dir=${join(root, 'profile')}`], env: testEnv({ PI_WEB_DATA_DIR: data, PI_WEB_CWD: cwd }) });
		for (let i = 0; i < 250; i++) { page = app.windows().find(window => window.url().startsWith('http://127.0.0.1:')); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)); }
		assert(page); await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.setContentSize(1440, 1000); });
		await page.setViewportSize({ width: 1440, height: 1000 });
	} else {
		harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data } });
		browser = await chromium.launch({ executablePath: CHROME_PATH }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		await page.goto(`http://127.0.0.1:${harness.port}`);
	}
	page.setDefaultTimeout(40000);
	const requests = [], errors = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('request', request => { if (new URL(request.url()).pathname === '/api/system-prompt') requests.push({ url: request.url(), body: request.postDataJSON() }); });
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.getByRole('button', { name: '设置', exact: true }).and(page.locator(':visible')).first().click();
	await page.getByText('所有设置', { exact: true }).click();
	const panel = page.getByRole('region', { name: '系统提示词', exact: true });
	await panel.locator('.omp-prompt-file').first().waitFor();
	await panel.locator('.omp-prompt-raw > summary').click();
	await panel.locator('.omp-prompt-raw').getByText('UI_GLOBAL_MARKER', { exact: false }).waitFor();
	const projectPath = join(cwd, '.omp/SYSTEM.md');
	const project = panel.locator('.omp-prompt-file').filter({ has: page.locator('code').filter({ hasText: projectPath }) });
	await project.getByRole('button', { name: '创建', exact: true }).click();
	const editor = panel.getByRole('textbox', { name: '提示词文件内容', exact: true });
	await editor.fill('UI_PROJECT_MARKER');
	assert(await panel.getByRole('button', { name: '重载当前会话提示词', exact: true }).isDisabled());
	await panel.getByRole('button', { name: '保存', exact: true }).click();
	await editor.waitFor({ state: 'detached' });
	assert.equal(readFileSync(projectPath, 'utf8'), 'UI_PROJECT_MARKER');
	await panel.getByRole('status').filter({ hasText: '磁盘文件已变更' }).waitFor();
	assert((await panel.locator('.omp-prompt-raw').innerText()).includes('UI_GLOBAL_MARKER'));
	assert(!(await panel.locator('.omp-prompt-raw').innerText()).includes('UI_PROJECT_MARKER'));
	await panel.getByRole('button', { name: '重载当前会话提示词', exact: true }).click();
	await panel.locator('.omp-prompt-raw').getByText('UI_PROJECT_MARKER', { exact: false }).waitFor();
	assert(!(await panel.locator('.omp-prompt-raw').innerText()).includes('UI_GLOBAL_MARKER'));
	await project.getByRole('button', { name: '编辑', exact: true }).click();
	await editor.fill('UNSAVED_DRAFT');
	page.once('dialog', dialog => dialog.dismiss());
	await page.getByRole('button', { name: 'OMP 工具', exact: true }).click();
	assert.equal(await editor.inputValue(), 'UNSAVED_DRAFT');
	await panel.getByRole('button', { name: '刷新来源', exact: true }).click();
	assert.equal(await editor.inputValue(), 'UNSAVED_DRAFT', 'metadata refresh preserves the draft');
	writeFileSync(projectPath, 'EXTERNAL_EDIT_MARKER');
	await panel.getByRole('button', { name: '保存', exact: true }).click();
	await panel.getByRole('alert').filter({ hasText: 'Prompt file changed' }).waitFor();
	assert.equal(readFileSync(projectPath, 'utf8'), 'EXTERNAL_EDIT_MARKER'); assert.equal(await editor.inputValue(), 'UNSAVED_DRAFT');
	page.once('dialog', dialog => dialog.accept());
	await panel.getByRole('button', { name: '重新读取文件', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.omp-prompt-panel textarea')?.value === 'EXTERNAL_EDIT_MARKER');
	await panel.getByRole('button', { name: '取消', exact: true }).click();
	await panel.getByRole('button', { name: '刷新来源', exact: true }).click();
	page.once('dialog', dialog => dialog.accept()); await project.getByRole('button', { name: '删除', exact: true }).click();
	await project.getByRole('button', { name: '创建', exact: true }).waitFor(); assert(!existsSync(projectPath));
	await panel.getByRole('button', { name: '重载当前会话提示词', exact: true }).click();
	await panel.locator('.omp-prompt-raw').getByText('UI_GLOBAL_MARKER', { exact: false }).waitFor();
	const owner = requests.find(request => request.body.action === 'get'); assert(owner);
	const post = (body, origin = new URL(page.url()).origin) => fetch(owner.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ ...owner.body, ...body }) });
	assert.equal((await post({ conversationId: 'other', action: 'reload' })).status, 409);
	assert.equal((await post({ action: 'get' }, 'https://invalid.example')).status, 403);
	await page.setViewportSize({ width: 390, height: 844 }); await panel.scrollIntoViewIfNeeded();
	assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
	await panel.locator('.omp-prompt-raw > summary').click();
	await project.getByRole('button', { name: '创建', exact: true }).click();
	await editor.fill('NARROW_EDITOR_DRAFT'); await editor.scrollIntoViewIfNeeded();
	assert.equal(await editor.evaluate(element => getComputedStyle(element).fontSize), '16px');
	for (const appearance of ['light', 'dark']) { await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance); await page.screenshot({ path: `tests/scratch/omp-prompt-${appearance}.png` }); }
	page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '取消', exact: true }).click();
	const socketUrl = new URL(owner.url); socketUrl.protocol = 'ws:'; socketUrl.pathname = '/ws';
	socket = new WebSocket(socketUrl);
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
	const ready = new Promise(resolve => socket.on('message', raw => { if (JSON.parse(raw).type === 'ready') resolve(); }));
	socket.send(JSON.stringify({ type: 'hello', clientId: owner.body.clientId })); await ready; socket.send(JSON.stringify({ type: 'abort' }));
	let stopped = false;
	for (let i = 0; i < 100; i++) { if ((await (await post({ action: 'get' })).json()).available === false) { stopped = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
	assert(stopped);
	await panel.getByRole('button', { name: '刷新来源', exact: true }).click();
	await panel.getByRole('status').filter({ hasText: '当前会话已停止' }).waitFor();
	assert.equal((await (await post({ action: 'get' })).json()).available, false);
	assert.deepEqual(errors, []);
	console.log('PASS OMP prompt UI: native files and effective prompt, explicit reload, draft/conflict/deletion guards, ownership/Origin, stopped reads and narrow themes');
} catch (error) { if (page) await page.screenshot({ path: 'tests/scratch/omp-prompt-failure.png', timeout: 3000 }).catch(() => {}); throw error; }
finally {
	socket?.terminate(); await browser?.close();
	if (app) { await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {}); await app.close(); }
	await harness?.stop(); rmSync(root, { recursive: true, force: true });
}
