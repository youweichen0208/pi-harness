/** Real native persistence: competing ownership, filesystem failure, scoped stop and explicit recovery. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadOmpTestModule, ompTestRoot } from './lib/omp-runtime-location.mjs';
import { listenIsolated } from './lib/isolated-server.mjs';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete process.env[key];
const { OmpClientSession } = await loadOmpTestModule('chat-service.js');
const { OmpSession } = await loadOmpTestModule('session.js');
const { ClientStateStore } = await import(pathToFileURL(join(ompTestRoot, 'dist/server/client-state.js')).href);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'omp-persistence-'))), agent = join(root, 'omp/agent');
// Do not depend on renaming an open native transcript's directory on Windows.
// Exercise the same failed-persistence contract through an explicit I/O fault.
const injectIo = process.platform === 'win32' || process.env.HARNESS_TEST_PERSISTENCE_FAULT === 'io';
const faultMarker = join(root, 'history-io-fault.json');
if (injectIo) {
	process.env.FIXTURE_HISTORY_IO_FAULT = faultMarker;
	process.env.BUN_OPTIONS = `--preload=${fileURLToPath(new URL('./fixtures/history-io-fault.mjs', import.meta.url))}`;
}
const workA = join(root, 'a'), workB = join(root, 'b');
for (const path of [agent, workA, workB]) mkdirSync(path, { recursive: true });
const requests = [], events = [], holds = new Map();
let client, contender, blockedDirectory;
const provider = createServer(async (req, res) => {
	let raw = ''; for await (const part of req) raw += part;
	const request = JSON.parse(raw); requests.push(request);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	const finish = () => {
		emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
		emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Native persistence fixture reply.' } });
		emit('content_block_stop', { index: 0 });
		emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } });
		emit('message_stop', {}); res.end();
	};
	const last = JSON.stringify(request.messages.filter(message => message.role === 'user').at(-1));
	const hold = ['HOLD_A', 'HOLD_B'].find(key => last.includes(key));
	if (hold) holds.set(hold, finish); else finish();
});
const wait = async (test, label) => { for (let i = 0; i < 1500; i++) { if (test()) return; await new Promise(r => setTimeout(r, 20)); } throw Error(`Timed out ${label}`); };
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: true }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	client = new OmpClientSession('persistence', workA, new ClientStateStore(join(root, 'client-state.json')));
	client.attachSink(event => events.push(event), false);
	await client.initialize(); await client.setModel('fixture/fixture');
	await client.prompt('ORIGINAL_A'); await wait(() => !client.session.state.running, 'A seed'); await client.session.refresh();
	const a = client.session, aId = client.conversationId, originalFile = a.state.sessionFile;
	await client.setCwd(workB); await client.setModel('fixture/fixture');
	await client.prompt('ORIGINAL_B'); await wait(() => !client.session.state.running, 'B seed'); await client.session.refresh();
	const b = client.session, bId = client.conversationId;
	assert.notEqual(dirname(a.state.sessionFile), dirname(b.state.sessionFile));
	const original = readFileSync(originalFile, 'utf8');
	contender = new OmpSession({ conversationId: 'competing-owner', dataDir: root, cwd: workA, sessionFile: originalFile, model: 'fixture/fixture', onChange() {} });
	await contender.open();
	await contender.command('set_label', { entryId: contender.state.messages.find(message => message.role === 'user').entryId, label: 'native relocation' });
	await wait(() => contender.state.persistence?.relocation, 'native relocation notice'); await contender.refresh();
	assert.equal(contender.state.persistence.failed, false);
	assert.equal(contender.state.persistence.relocation.fromFile, originalFile);
	assert.equal(contender.state.persistence.relocation.toFile, contender.state.sessionFile);
	assert.notEqual(contender.state.sessionFile, originalFile);
	assert.equal(readFileSync(originalFile, 'utf8'), original, 'the first writer retains its original file');
	assert(readFileSync(contender.state.sessionFile, 'utf8').includes('ORIGINAL_A'));
	await contender.close(); contender = undefined;
	await client.switchConversation(aId);
	await client.prompt('Continue after native relocation'); await wait(() => !a.state.running, 'relocated reply');
	await client.prompt('HOLD_A'); await wait(() => holds.has('HOLD_A'), 'A streaming');
	await client.prompt('MUST_NOT_AUTOREPLAY', undefined, 'followUp');
	await client.switchConversation(bId); await client.prompt('HOLD_B'); await wait(() => holds.has('HOLD_B'), 'B streaming');
	const beforeFailure = requests.length;
	if (injectIo) {
		writeFileSync(faultMarker + '.tmp', JSON.stringify({ file: a.state.sessionFile })); renameSync(faultMarker + '.tmp', faultMarker);
	} else {
		const directory = dirname(a.state.sessionFile);
		renameSync(directory, directory + '.saved'); blockedDirectory = directory;
		writeFileSync(directory, 'TEST_BLOCKED_STORAGE_SECRET');
	}
	holds.get('HOLD_A')();
	await wait(() => a.state.persistence?.failed && !a.state.running && !a.generation, 'durability failure stops its worker');
	if (injectIo) {
		const observed = JSON.parse(readFileSync(faultMarker + '.observed', 'utf8'));
		assert.equal(observed.code, 'EIO'); assert.equal(observed.writeObserved, true, 'native writer must actually encounter the injected fault');
		assert.equal(observed.file, a.state.sessionFile, 'only the selected history writer may fail');
	}
	assert.equal(client.conversationId, bId); assert.equal(b.state.running, true, 'background failure does not stop the foreground');
	assert.equal(requests.length, beforeFailure, 'failed history does not drain the queued follow-up');
	assert.deepEqual(a.state.queue, { steering: [], followUp: [] });
	assert(events.some(event => event.type === 'notice' && event.conversationId === aId && event.level === 'error'));
	assert(!JSON.stringify(events).includes('TEST_BLOCKED_STORAGE_SECRET'));
	await client.switchConversation(aId);
	await client.prompt('MUST_REJECT_UNTIL_REOPEN', undefined, undefined, 'failed-storage');
	assert(events.some(event => event.type === 'prompt_result' && event.requestId === 'failed-storage' && event.receipt === 'rejected'));
	await assert.rejects(a.setThinking('off')); await assert.rejects(a.command('fork'));
	assert.equal(a.generation, undefined, 'writes must not implicitly start a new worker');
	await client.handle({ type: 'session_reopen', conversationId: aId, reqId: 'still-broken' });
	assert(events.some(event => event.type === 'tree_navigate_result' && event.reqId === 'still-broken' && event.status === 'error'));
	assert.equal(a.state.persistence.failed, true);
	if (injectIo) rmSync(faultMarker);
	else { rmSync(blockedDirectory); renameSync(blockedDirectory + '.saved', blockedDirectory); blockedDirectory = undefined; }
	await client.handle({ type: 'session_reopen', conversationId: aId, reqId: 'repaired' });
	assert(events.some(event => event.type === 'tree_navigate_result' && event.reqId === 'repaired' && event.status === 'ok'));
	assert.equal(a.state.persistence.failed, false); assert.equal(requests.length, beforeFailure, 'reopen never repeats a request');
	await client.prompt('Explicit continuation after repair'); await wait(() => !a.state.running, 'manual continuation');
	holds.get('HOLD_B')(); await wait(() => !b.state.running, 'unaffected B completion');
	// Reopen must not recreate a deleted or empty transcript as a new session.
	await a.stop(); const saved = a.state.sessionFile, bytes = readFileSync(saved);
	rmSync(saved); await assert.rejects(a.reopen()); assert(!existsSync(saved));
	writeFileSync(saved, ''); await assert.rejects(a.reopen()); assert.equal(readFileSync(saved).length, 0);
	writeFileSync(saved, bytes); await a.reopen();
	console.log('PASS native OMP persistence: concurrent writer relocated without altering owner history, failure stops only its owner, no queued replay or implicit reopen, explicit recovery and missing/empty history refused');
} finally {
	rmSync(faultMarker, { force: true });
	if (blockedDirectory) { rmSync(blockedDirectory, { force: true }); renameSync(blockedDirectory + '.saved', blockedDirectory); }
	await contender?.close(); await client?.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
