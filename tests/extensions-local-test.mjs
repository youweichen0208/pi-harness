/** No system pi/node/npm/git: local files still load through the bundled SDK. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const appRoot = resolve(process.argv[2] || '.');
const root = mkdtempSync(join(tmpdir(), 'pi-local-ext-'));
const cwd = join(root, '项目 space'), agentDir = join(root, '自定义 agent'), emptyPath = join(root, 'empty-bin');
for (const dir of [cwd, agentDir, emptyPath]) mkdirSync(dir);
const settings = JSON.stringify({ packages: [], defaultTools: [], retry: { enabled: false } });
writeFileSync(join(agentDir, 'settings.json'), settings);
writeFileSync(join(agentDir, 'webui-extensions.json'), JSON.stringify({ autoCheck: false }));
let harness, ws;
const env = testEnv({ PATH: emptyPath, Path: emptyPath, PI_WEB_CWD: cwd, PI_CODING_AGENT_DIR: agentDir, PI_WEB_DATA_DIR: join(root, 'data'), PI_WEB_PKG_ROOT: appRoot });
try {
	harness = await startIsolatedHarness({ env, args: [join(appRoot, 'dist/server/index.js')] });
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	const ready = new Promise(resolve => ws.on('message', raw => { if (JSON.parse(String(raw)).type === 'snapshot') resolve(); }));
	ws.send(JSON.stringify({ type: 'hello', clientId: 'local-extension-test' }));
	await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(Error('No snapshot')), 10000).unref())]);
	const request = async (action, args = {}) => {
		const response = await fetch(`http://127.0.0.1:${harness.port}/api/extensions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'local-extension-test', cwd, action, ...args }) });
		return { status: response.status, ...await response.json() };
	};
	assert.equal((await request('open-info', { id: 'extensions:user', cwd: root })).status, 409);
	const directory = await request('open-info', { id: 'extensions:user', path: root });
	assert.equal(directory.status, 200); assert.equal(directory.absolute, join(agentDir, 'extensions'));
	assert(existsSync(directory.absolute)); assert(!existsSync(join(cwd, '.pi/extensions')));
	const file = join(directory.absolute, 'hello.ts');
	const source = 'export default function(pi) { pi.registerCommand("local-fixture", { description: "Local test", handler: async () => {} }); }';
	writeFileSync(file, source);
	await request('open-info', { id: 'extensions:user' });
	assert.equal(readFileSync(file, 'utf8'), source);
	const state = await request('list'); assert.equal(state.status, 200); assert(state.packages.some(item => item.path === file));
	assert.equal((await request('open-info', { id: root })).status, 400);
	// An unusable directory must not prevent package browsing.
	rmSync(directory.absolute, { recursive: true }); writeFileSync(directory.absolute, 'blocked');
	assert.equal((await request('open-info', { id: 'extensions:user' })).status, 400);
	assert.equal((await request('list')).status, 200);
	rmSync(directory.absolute); await request('open-info', { id: 'extensions:user' }); writeFileSync(file, source);
	const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')));
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir), noSkills: true, noPromptTemplates: true });
	const previousPath = process.env.PATH;
	try {
		process.env.PATH = emptyPath;
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert(loader.getExtensions().extensions.some(extension => extension.commands.has('local-fixture')));
		writeFileSync(join(directory.absolute, 'second.ts'), source.replaceAll('local-fixture', 'second-fixture'));
		await loader.reload();
		assert(loader.getExtensions().extensions.some(extension => extension.commands.has('second-fixture')));
	} finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
	assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), settings);
	console.log('PASS local extension directory, restricted paths, directory failure, real SDK loading/reload without system tools');
} finally { ws?.terminate(); await harness?.stop(); rmSync(root, { recursive: true, force: true }); }
