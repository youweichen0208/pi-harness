/** Real Desktop directory IPC; only the OS file-manager call is intercepted. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import { testEnv } from './lib/test-env.mjs';
const root = mkdtempSync(join(tmpdir(), 'pi-extension-directory-'));
const cwd = join(root, 'workspace'), agent = join(root, '个人 agent'), empty = join(root, 'empty-bin');
for (const dir of [cwd, agent, empty]) mkdirSync(dir);
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
let app;
try {
	const executable = process.argv[2];
	app = await electron.launch({ ...(executable ? { executablePath: resolve(executable) } : {}), args: [...(executable ? [] : ['.']), `--user-data-dir=${join(root, 'profile')}`], env: testEnv({ PI_WEB_DATA_DIR: join(root, 'data'), PI_WEB_CWD: cwd, PI_CODING_AGENT_DIR: agent, PATH: empty, Path: empty }) });
	let page;
	for (let i = 0; i < 200; i++) { page = app.windows().find(window => window.url().startsWith('http://127.0.0.1:')); if (page) break; await sleep(100); }
	assert(page); page.setDefaultTimeout(15000);
	await app.evaluate(({ shell }) => { globalThis.openedExtensionFolders = []; shell.openPath = async path => { globalThis.openedExtensionFolders.push(path); return ''; }; });
	await page.getByRole('button', { name: '设置', exact: true }).first().click();
	await page.getByText('所有设置', { exact: true }).click();
	await page.getByRole('button', { name: 'Extensions', exact: true }).click();
	await page.getByRole('button', { name: '打开个人扩展目录', exact: true }).click();
	for (let i = 0; i < 50 && !(await app.evaluate(() => globalThis.openedExtensionFolders.length)); i++) await sleep(100);
	assert.deepEqual(await app.evaluate(() => globalThis.openedExtensionFolders), [join(agent, 'extensions')]);
	console.log('PASS Desktop personal extension folder opens through validated IPC without system tools');
} finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
