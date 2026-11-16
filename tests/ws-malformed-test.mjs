/**
 * A malformed client message must never take the server down.
 * These types used to crash the whole process (TypeError in the handler):
 * the server must stay up, report sync failures as a notice, and keep serving.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { startIsolatedHarness } from './lib/isolated-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'pi-malformed-'));
const cwd = join(root, 'ws'); mkdirSync(cwd);
const dataDir = join(root, 'data'), agent = join(dataDir, 'omp/agent');
mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
let harness, ws, exited = null;
const notices = [], messages = [];
const wait = async (predicate, label) => { for (let i = 0; i < 600; i++) { if (predicate()) return; await sleep(50); } throw Error('Timed out ' + label); };

const CRASHERS = {
	edit_message: { messageId: 'm', text: [] },
	browse_dirs: { path: 123 },
	list_files: { path: 123 },
	search_files: { query: 123, reqId: 1 },
	set_provider_api_key: { provider: [], apiKey: [] },
	clear_provider_api_key: { provider: {} },
	save_model_config: { providerId: [], config: null },
	clone_provider: { provider: [], reqId: 1 },
	terminal_input: {},
	plugin_settings: {},
	// Still dispatched synchronously by the host, independently of OMP.
	project_workspace_action: { requestId: null },
};

try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: dataDir } });
	const PORT = harness.port;
	harness.child.on('exit', (code, signal) => { exited = { code, signal }; });
	ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	ws.on('message', d => { const m = JSON.parse(d); messages.push(m); if (m.type === 'notice') notices.push(m); });
	await once(ws, 'open');
	ws.send(JSON.stringify({ type: 'hello', clientId: randomUUID() }));
	await wait(() => messages.some(message => message.type === 'ready'), 'OMP ready handshake');
	for (const [type, fields] of Object.entries(CRASHERS)) {
		ws.send(JSON.stringify({ type, ...fields }));
		await sleep(60);
		assert.equal(exited, null, `server must survive malformed "${type}"\n${harness.logs.slice(-600)}`);
		if (type === 'edit_message') await wait(() => notices.some(notice => notice.level === 'error'), 'asynchronous OMP rejection');
	}
	ws.send(JSON.stringify({ type: 'ping-after-malformed-and-not-a-real-type' }));
	ws.send('not json at all');
	const snapshotCount = messages.filter(message => message.type === 'snapshot').length;
	ws.send(JSON.stringify({ type: 'get_state' }));
	await wait(() => messages.filter(message => message.type === 'snapshot').length > snapshotCount, 'snapshot after malformed inputs');
	assert.equal(exited, null);
	assert((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok, 'server still answers HTTP');
	await wait(() => notices.some(notice => notice.level === 'error' && /请求处理失败（project_workspace_action）/.test(notice.text)), 'synchronous host rejection');
	ws.close();
	// A clientId that could leave uploads/<clientId>/ is refused at the handshake (4400).
	for (const bad of ['../../escape', 'a/b', '.hidden']) {
		const evil = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const closed = new Promise(resolve => evil.on('close', code => resolve(code)));
		await once(evil, 'open');
		evil.send(JSON.stringify({ type: 'hello', clientId: bad }));
		assert.equal(await closed, 4400, `clientId ${bad} must be rejected`);
	}
	console.log('PASS malformed messages: OMP async and host sync errors are reported after ready, HTTP/snapshots remain available, unsafe clientIds are refused');
} finally {
	ws?.terminate();
	await harness?.stop();
	rmSync(root, { recursive: true, force: true });
}
