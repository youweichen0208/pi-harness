/** Runs only inside the disposable image fixture, with no network except loopback. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { mergeSnapshot } from './snapshots.mjs';

assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1000);
assert.equal(process.env.PI_WEB_DATA_DIR, '/data/pi-harness'); assert.equal(process.env.PI_WEB_CWD, '/workspace');
const phase = process.argv[2]; assert(['prepare', 'seed', 'restore'].includes(phase));
if (phase === 'prepare') {
	// The host created and verified ownership of this disposable volume. Old
	// non-empty volumes do not receive newly added image directories on mount.
	rmSync('/data/omp-native', { recursive: true, force: true });
	mkdirSync('/data/pi-agent', { recursive: true });
	writeFileSync('/data/pi-agent/fixture-sentinel', 'OLD_DATA_UNCHANGED');
	console.log('Prepared existing non-empty volume without the new native root');
	process.exit(0);
}
assert.equal(readFileSync('/data/pi-agent/fixture-sentinel', 'utf8'), 'OLD_DATA_UNCHANGED');
const require = createRequire('/app/package.json'), WebSocket = require('ws');
const { OmpPackages } = await import('/app/dist/server/omp/packages.js');
const data = process.env.PI_WEB_DATA_DIR, cwd = process.env.PI_WEB_CWD, agent = join(data, 'omp/agent');
const marker = join(data, 'container-extension-loads'), manifestFile = join(data, 'container-fixture.json');
const name = 'omp-container-fixture', events = [], requests = [];
let server, closed, socket, state, logs = '', registry;
const packages = new OmpPackages(data);
const wait = async (check, label) => { for (let i = 0; i < 1200; i++) { if (await check()) return; await sleep(25); } throw Error(`Timed out ${label}: ${logs.slice(-6000)}`); };
const config = JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:9024', apiKey: 'container-fixture-only', models: [{ id: 'fixture', contextWindow: 200000 }] } } });
const gateway = createServer(async (req, res) => {
	let raw = ''; for await (const part of req) raw += part;
	const payload = JSON.parse(raw); requests.push(payload);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
	emit('message_start', { message: { id: `fixture-${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
	const read = JSON.stringify(payload.messages.at(-1)?.content).includes('CONTAINER_READ');
	emit('content_block_start', { index: 0, content_block: read ? { type: 'tool_use', id: 'read-container', name: 'read', input: {} } : { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: read ? { type: 'input_json_delta', partial_json: '{"path":"fixture.txt"}' } : { type: 'text_delta', text: 'CONTAINER_NATIVE_DONE' } });
	emit('content_block_stop', { index: 0 });
	emit('message_delta', { delta: { stop_reason: read ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 12 } });
	emit('message_stop', {}); res.end();
});
try {
	mkdirSync(agent, { recursive: true }); writeFileSync(join(cwd, 'fixture.txt'), 'NATIVE_CONTAINER_TOOL_RESULT');
	if (phase === 'seed') {
		writeFileSync(join(agent, 'models.yml'), config);
		writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
		mkdirSync('/tmp/fixture-package/package', { recursive: true });
		writeFileSync('/tmp/fixture-package/package/package.json', JSON.stringify({ name, version: '1.0.0', type: 'module', omp: { extensions: ['./extension.js'] } }));
		writeFileSync('/tmp/fixture-package/package/extension.js', `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'loaded\\n'); export default api => {};`);
		execFileSync('tar', ['-czf', '/tmp/fixture-package.tgz', '-C', '/tmp/fixture-package', 'package']);
		const archive = readFileSync('/tmp/fixture-package.tgz');
		registry = createServer((req, res) => {
			if (req.url === `/${name}`) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0', dist: { tarball: 'http://127.0.0.1:9025/package.tgz', shasum: createHash('sha1').update(archive).digest('hex') } } } })); }
			else if (req.url === '/package.tgz') res.end(archive);
			else { res.writeHead(404); res.end(); }
		});
		registry.listen(9025, '127.0.0.1'); await once(registry, 'listening');
		const initial = await packages.list(cwd); mkdirSync(initial.root, { recursive: true });
		writeFileSync(join(initial.root, '.npmrc'), 'registry=http://127.0.0.1:9025\n');
		const owner = { clientId: 'container', conversationId: 'package-fixture', cwd }, id = randomUUID();
		packages.start(owner, id, await packages.preview(cwd, 'install', `${name}@1.0.0`));
		await wait(() => packages.get(owner, id).phase !== 'running', 'native package install');
		assert.equal(packages.get(owner, id).phase, 'success');
		rmSync(join(initial.root, '.npmrc'));
	} else {
		assert.equal(readFileSync(join(agent, 'models.yml'), 'utf8'), config, 'model configuration survives replacement');
	}
	const installed = (await packages.list(cwd)).items.find(item => item.name === name);
	console.log(JSON.stringify({ phase, packageRetained: Boolean(installed), nativePackageRoot: (await packages.list(cwd)).root }));
	assert(installed?.enabled && installed.version === '1.0.0', 'native installed package must survive container replacement');
	assert(existsSync(join(installed.path, 'extension.js')));
	const loadsBefore = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
	await packages.close();
	gateway.listen(9024, '127.0.0.1'); await once(gateway, 'listening');
	server = spawn('node', ['dist/server/index.js'], { cwd: '/app', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
	closed = new Promise(resolveExit => server.once('close', code => resolveExit(code)));
	for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logs = (logs + data).slice(-20000); });
	await wait(async () => { try { return (await (await fetch('http://127.0.0.1:9023/api/health')).json()).agentEngine === 'omp'; } catch { return false; } }, 'production HTTP entry');
	socket = new WebSocket('ws://127.0.0.1:9023/ws');
	socket.on('message', raw => { const message = JSON.parse(raw); events.push(message); state = mergeSnapshot(state, message); });
	await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', clientId: 'container' }));
	await wait(() => state && events.some(event => event.type === 'ready'), 'native session ready');
	assert(state.tools.includes('read') && state.tools.includes('task'));
	assert(!state.tools.includes('subagent') && !state.tools.includes('codemode'));
	assert(readFileSync(marker, 'utf8').length > loadsBefore.length, 'persisted native package loads in the actual session');
	if (phase === 'seed') {
		socket.send(JSON.stringify({ type: 'set_model', modelId: 'fixture/fixture' })); await wait(() => state.model?.id === 'fixture', 'model selection');
		socket.send(JSON.stringify({ type: 'prompt', text: 'CONTAINER_READ', requestId: 'container-read', target: { cwd: state.cwd, conversationId: state.conversationId, sessionId: state.sessionId } }));
		await wait(() => !state.isStreaming && state.messages.some(message => message.content.some(block => block.text === 'CONTAINER_NATIVE_DONE')), 'native file read');
		assert(requests.some(request => JSON.stringify(request.messages).includes('NATIVE_CONTAINER_TOOL_RESULT')));
		assert(requests.every(request => request.max_tokens === 16384), 'native default is not forced to 128000');
		const files = readdirSync(join(data, 'omp/sessions'), { recursive: true }).filter(file => file.endsWith('.jsonl')); assert(files.length);
		writeFileSync(manifestFile, JSON.stringify({ sessionId: state.sessionId, conversationId: state.conversationId, files, packagePath: realpathSync(installed.path) }));
	} else {
		const saved = JSON.parse(readFileSync(manifestFile, 'utf8'));
		assert.equal(state.sessionId, saved.sessionId);
		assert.notEqual(state.conversationId, saved.conversationId, 'runtime conversation handles are renewed while the native session persists');
		assert(state.messages.some(message => message.content.some(block => block.text === 'CONTAINER_NATIVE_DONE')));
		assert.equal(requests.length, 0, 'container replacement never replays a previous task');
		assert.equal(realpathSync(installed.path), saved.packagePath);
		assert(saved.packagePath.startsWith('/data/omp-native/'), 'native packages physically belong to the persistent volume');
		for (const file of saved.files) assert(existsSync(join(data, 'omp/sessions', file)));
	}
	const terminalId = `container-${phase}`;
	const send = value => socket.send(JSON.stringify(value));
	send({ type: 'terminal_create', terminalId, cwd, cols: 80, rows: 24 });
	await wait(() => events.some(event => event.type === 'terminal_output' && event.terminalId === terminalId), 'native PTY startup');
	send({ type: 'terminal_input', terminalId, data: "printf 'CONTAINER_%s\\n' PTY_OK\r" });
	await wait(() => events.filter(event => event.type === 'terminal_output' && event.terminalId === terminalId).map(event => event.data).join('').includes('CONTAINER_PTY_OK'), 'real PTY command result');
	send({ type: 'terminal_input', terminalId, data: 'exit\r' });
	await wait(() => events.some(event => event.type === 'terminal_exit' && event.terminalId === terminalId && event.exitCode === 0), 'native PTY exit');
	console.log(`PASS container ${phase}: actual HTTP/WebSocket/PTY, OMP tools/package, native defaults and persisted history`);
} finally {
	socket?.terminate(); await packages.close();
	if (server && server.exitCode === null) { server.kill('SIGTERM'); const force = setTimeout(() => server.kill('SIGKILL'), 15000); try { await closed; } finally { clearTimeout(force); } }
	for (const listener of [gateway, registry]) if (listener?.listening) { listener.closeAllConnections(); await new Promise(resolveClose => listener.close(resolveClose)); }
}
