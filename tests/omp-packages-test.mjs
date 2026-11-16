/** Real native package operations against a private local registry; no user config writes. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadOmpTestModule } from './lib/omp-runtime-location.mjs';
import { listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
import express from 'express';
const { OmpPackages, createOmpPackageRunner } = await loadOmpTestModule('packages.js');
const { installOmpRoutes } = await loadOmpTestModule('routes.js');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-packages-')));
const configRoot = join(root, 'native'), plugins = join(configRoot, 'plugins'), agent = join(root, 'agent'), counter = join(root, 'imports');
for (const path of [plugins, agent]) mkdirSync(path, { recursive: true });
writeFileSync(counter, '');
const name = 'omp-harness-package-fixture';
const archives = new Map();
for (const version of ['1.0.0', '1.1.0', '2.0.0']) {
	const directory = join(root, `source-${version}`); mkdirSync(join(directory, 'package'), { recursive: true });
	writeFileSync(join(directory, 'package/package.json'), JSON.stringify({ name, version, type: 'module', omp: { extensions: ['./extension.js'], settings: { token: { type: 'string', default: 'MANIFEST_SECRET' } } } }));
	writeFileSync(join(directory, 'package/extension.js'), `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify(version + '\n')}); console.log('FACTORY_SECRET'); ${version === '2.0.0' ? "throw Error('FACTORY_SECRET');" : 'export default api => {};'}`);
	const tarball = join(root, `package-${version}.tgz`);
	execFileSync('tar', ['-czf', tarball, '-C', directory, 'package']); archives.set(version, readFileSync(tarball));
}
let latest = '1.0.0', base, registryRequests = 0, hold = false;
const registry = createServer((req, res) => {
	registryRequests++;
	if (hold) return;
	if (req.url === `/${name}`) {
		const versions = Object.fromEntries([...archives].map(([version, archive]) => [version, { name, version, dist: { tarball: `${base}/${version}.tgz`, shasum: createHash('sha1').update(archive).digest('hex') } }]));
		res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name, 'dist-tags': { latest }, versions }));
	} else {
		const archive = archives.get(req.url?.slice(1, -4));
		if (!archive) { res.writeHead(404); res.end(); } else { res.setHeader('Content-Type', 'application/octet-stream'); res.end(archive); }
	}
});
const owner = { clientId: 'client-a', conversationId: 'conversation-a', cwd: root };
let service, api;
const wait = async fn => { for (let n = 0; n < 400; n++) { const value = fn(); if (value) return value; await sleep(50); } throw Error('Timed out'); };
try {
	base = `http://127.0.0.1:${await listenIsolated(registry)}`;
	writeFileSync(join(plugins, '.npmrc'), `registry=${base}\n`);
	// PI_CONFIG_DIR is the SDK's public override. HOME is never changed. This
	// isolates native package tests; the product uses the normal native root.
	const env = { ...testEnv(), PI_CONFIG_DIR: relative(homedir(), configRoot), PI_CODING_AGENT_DIR: agent, PI_NOTIFICATIONS: 'off', BUN_INSTALL_CACHE_DIR: join(root, 'cache'), PATH: '', Path: '' };
	delete env.ELECTRON_RUN_AS_NODE;
	for (const key of Object.keys(env)) if (key.startsWith('OMP_')) delete env[key];
	const runner = createOmpPackageRunner(root, { env });
	service = new OmpPackages(root, runner);
	let paused = false, running = false, apiOrigin;
	const client = { cwd: root, conversationId: owner.conversationId, switchingWorkspace: false, session: { state: { get running() { return running; } } } };
	const app = express(); app.use(express.json());
	installOmpRoutes(app, () => ({ packages: service, get: id => id === owner.clientId ? client : undefined, isQuiesced: () => paused }), request => request.get('Origin') === apiOrigin);
	api = createServer(app); apiOrigin = `http://127.0.0.1:${await listenIsolated(api)}`;
	const post = (body, origin = apiOrigin) => fetch(`${apiOrigin}/api/omp-packages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ ...owner, ...body }) });
	assert.equal((await post({ action: 'list' }, 'https://foreign.example')).status, 403);
	assert.equal((await post({ action: 'list', conversationId: 'foreign' })).status, 409);
	assert.equal((await post({ action: 'list' })).status, 200);
	const execute = async (operation, target) => {
		const plan = await service.preview(root, operation, target), id = randomUUID();
		const initial = service.start(owner, id, plan); assert.equal(initial.phase, 'running');
		const job = await wait(() => { const state = service.get(owner, id); return state.phase !== 'running' && state; });
		assert.equal(job.phase, 'success', JSON.stringify(job)); return job;
	};
	assert.equal((await service.list(root)).root, plugins);
	assert.deepEqual((await service.list(root)).items, []);
	const firstPlan = await service.preview(root, 'install', `${name}@1.0.0`);
	paused = true; assert.equal((await post({ action: 'start', id: randomUUID(), plan: firstPlan })).status, 400); paused = false;
	running = true; assert.equal((await post({ action: 'start', id: randomUUID(), plan: firstPlan })).status, 400); running = false;
	assert.equal(registryRequests, 0, 'preview does not contact registry');
	assert(!existsSync(join(plugins, 'package.json')), 'preview does not initialize native manifests');
	assert.equal(readFileSync(counter, 'utf8'), '');
	await assert.rejects(service.preview(root, 'install', 'https://user:SECRET@example.org/repo'));
	await execute('install', `${name}@1.0.0`);
	let view = await service.list(root);
	assert.equal(view.items[0].version, '1.0.0');
	assert(!JSON.stringify(view).includes('MANIFEST_SECRET'));
	const afterInstall = readFileSync(counter, 'utf8'); assert(afterInstall.includes('1.0.0'));
	const pathPost = (target, extra = {}) => fetch(`${apiOrigin}/api/omp-paths`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: apiOrigin }, body: JSON.stringify({ ...owner, target, ...extra }) });
	const networkBeforePaths = registryRequests;
	const installedPath = await pathPost({ kind: 'package', name }); assert.equal(installedPath.status, 200);
	assert.deepEqual(await installedPath.json(), { absolute: realpathSync(view.items[0].path), kind: 'directory', exists: true });
	assert.equal((await pathPost({ kind: 'package', name: '../outside' })).status, 400);
	assert.equal((await pathPost({ kind: 'package', name }, { conversationId: 'stale' })).status, 409);
	assert.equal(registryRequests, networkBeforePaths, 'path lookup does not access the registry');
	assert.equal(readFileSync(counter, 'utf8'), afterInstall, 'path lookup does not execute module factories');
	// A slow metadata lookup must recheck the conversation before exposing its path.
	const nativeList = service.list.bind(service); let entered = false, releaseList;
	service.list = async cwd => { entered = true; await new Promise(resolve => { releaseList = resolve; }); return nativeList(cwd); };
	const pendingPath = pathPost({ kind: 'package', name }); await wait(() => entered);
	client.conversationId = 'changed-conversation'; releaseList();
	assert.equal((await pendingPath).status, 409);
	client.conversationId = owner.conversationId; service.list = nativeList;

	await service.list(root); await service.preview(root, 'update', name);
	assert.equal(readFileSync(counter, 'utf8'), afterInstall, 'read and preview do not execute extension factories');
	const stale = await (await post({ action: 'start', id: randomUUID(), plan: firstPlan })).json();
	await wait(() => service.get(owner, stale.id).phase !== 'running');
	assert.equal(service.get(owner, stale.id).error, 'conflict');
	assert.equal((await (await post({ action: 'job', id: stale.id })).json()).error, 'conflict');
	await execute('disable', name); assert.equal((await service.list(root)).items[0].enabled, false);
	latest = '1.1.0'; await execute('update', name);
	view = await service.list(root); assert.equal(view.items[0].version, '1.1.0'); assert.equal(view.items[0].enabled, false, 'native upgrade preserves runtime state');
	const before = readFileSync(join(plugins, 'package.json'), 'utf8');
	latest = '2.0.0';
	const badPlan = await service.preview(root, 'update', name), bad = service.start(owner, randomUUID(), badPlan);
	await wait(() => service.get(owner, bad.id).phase !== 'running');
	assert.equal(service.get(owner, bad.id).phase, 'failed');
	assert(!JSON.stringify(service.get(owner, bad.id)).includes('FACTORY_SECRET'));
	assert.equal(readFileSync(join(plugins, 'package.json'), 'utf8'), before, 'native failed install rolls back manifest');
	assert.equal((await service.list(root)).items[0].version, '1.1.0', 'native failed validation restores installed package');
	await execute('enable', name); assert.equal((await service.list(root)).items[0].enabled, true);
	await execute('remove', name); assert.deepEqual((await service.list(root)).items, []);
	const source = join(root, 'source-1.0.0/package');
	await execute('link', source);
	assert.equal((await service.list(root)).items[0].updatable, false);
	await assert.rejects(service.preview(root, 'update', name));
	await assert.rejects(service.preview(root, 'link', source));
	await execute('remove', name);
	assert(existsSync(join(source, 'extension.js')), 'removing a linked package preserves source');
	const plan = await service.preview(root, 'install', `${name}@1.0.0`), id = randomUUID();
	hold = true; const count = registryRequests;
	service.start(owner, id, plan); service.start(owner, id, plan);
	assert.equal(service.activeCount(), 1);
	assert.throws(() => service.start(owner, id, { ...plan, target: 'different' }));
	assert.throws(() => service.get({ ...owner, conversationId: 'foreign' }, id));
	assert.throws(() => service.start(owner, randomUUID(), plan), /running/);
	await wait(() => registryRequests > count);
	const competing = new OmpPackages(join(root, 'second-host'), runner);
	try {
		const competitor = competing.start(owner, randomUUID(), plan);
		await wait(() => competing.get(owner, competitor.id).phase !== 'running');
		assert.equal(competing.get(owner, competitor.id).error, 'busy', 'independent workers serialize on the native package root');
		assert.equal(service.get(owner, id).phase, 'running', 'another host cannot terminate the owner worker');
	} finally { await competing.close(); }
	await service.cancel(owner, id);
	assert.equal(service.activeCount(), 0);
	assert.equal(service.get(owner, id).phase, 'unknown');
	const requestsAtStop = registryRequests; await sleep(150); assert.equal(registryRequests, requestsAtStop, 'cancel does not retry');
	await service.close();
	service = new OmpPackages(root, runner);
	assert.equal(service.get(owner, id).phase, 'unknown', 'job outcome survives host service recreation');
	assert.equal(service.start(owner, id, plan).phase, 'unknown', 'same request ID never re-executes');
	assert(service.jobs(owner).length >= 8);
	assert.deepEqual(service.jobs({ ...owner, clientId: 'foreign' }), []);
	const deadHost = spawnSync(process.execPath, ['-e', 'process.exit(0)']); assert.equal(deadHost.status, 0);
	const lostId = randomUUID();
	writeFileSync(join(root, 'omp/package-jobs', `${lostId}.json`), JSON.stringify({ owner, hostPid: deadHost.pid, job: { id: lostId, plan, phase: 'running', startedAt: Date.now() } }));
	assert.equal(service.get(owner, lostId).phase, 'unknown', 'only a confirmed exited host is treated as lost');
	// A slow read worker must also finish shutting down before the host exits.
	let started, acknowledge;
	const began = new Promise(resolve => { started = resolve; });
	const reader = new OmpPackages(join(root, 'reader-host'), async (_cwd, _request, signal) => new Promise(resolve => {
		signal.addEventListener('abort', () => { acknowledge = () => resolve({ ok: true, data: { items: [] } }); }); started();
	}));
	const reading = reader.list(root); await began;
	let closed = false; const closing = reader.close().then(() => { closed = true; });
	await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false, 'host waits for read worker termination');
	acknowledge(); await closing; await reading;
	console.log('PASS OMP packages: native registry install/upgrade/rollback/remove, links, readonly preview, secret projection, durable idempotent jobs, ownership and interrupted-operation recovery');
} finally {
	await service?.close(); api?.closeAllConnections(); if (api) await new Promise(resolve => api.close(resolve)); registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)); rmSync(root, { recursive: true, force: true });
}
