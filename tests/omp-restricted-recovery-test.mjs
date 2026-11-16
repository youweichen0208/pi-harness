/** Real OMP recovery through the SSH and Playground business adapters. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ompTestRoot } from './lib/omp-runtime-location.mjs';
import { listenIsolated } from './lib/isolated-server.mjs';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)) delete process.env[key];
const { NodeAgent } = await import(pathToFileURL(join(ompTestRoot, 'dist/server/node-agent.js')));
const { PlaygroundChat } = await import(pathToFileURL(join(ompTestRoot, 'dist/server/playground-chat.js')));
const root = mkdtempSync(join(tmpdir(), 'omp-restricted-recovery-')), agent = join(root, 'omp/agent');
mkdirSync(agent, { recursive: true });
const preload = join(root, 'local-only.mjs');
writeFileSync(preload, `const native = fetch; const guarded = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('FIXTURE_EXTERNAL_NETWORK'); return native(input, init); }; Object.assign(guarded, native); globalThis.fetch = guarded;`);
process.env.BUN_OPTIONS = `--preload=${preload}`;
let mode = 'normal', requests = 0, playground, pgState;
const nodes = [], holds = new Map(), events = [];
const provider = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	const payload = JSON.parse(raw); requests++;
	const last = JSON.stringify(payload.messages.filter(message => message.role === 'user').at(-1));
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
	emit('message_start', { message: { id: `m-${requests}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	const hold = ['HOLD_PEER', 'HOLD_FAILURE'].find(value => last.includes(value));
	if (hold || mode === 'hang') { holds.set(hold ?? 'compaction', res); res.once('close', () => { if (holds.get(hold ?? 'compaction') === res) holds.delete(hold ?? 'compaction'); }); return; }
	if (mode === 'retry') {
		emit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
		emit('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture reasoning' } });
		emit('content_block_stop', { index: 0 });
		emit('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }); res.end(); return;
	}
	emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Native restricted assistant fixture response. No tools were executed and no files were changed. Retain the earlier question as context and wait for the next explicit user request.' } });
	emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } }); emit('message_stop', {}); res.end();
});
const wait = async (fn, label) => { for (let i = 0; i < 1000; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error(`Timed out ${label}; requests=${requests}`); };
const noTool = () => { throw Error('Recovery must not execute remote tools'); };
const createNode = async name => { const node = new NodeAgent(join(root, 'nodes', name), '/srv', { command: noTool, read: noTool, write: noTool }, state => events.push(state), root); nodes.push(node); await node.start(); return node; };
const context = { code: 'print(1)', parameters: '', output: '', partial: false, stale: false, truncated: false };
const pg = async (action, extra = {}) => {
	const replies = [];
	await playground.handle('test-client', { type: 'playground_chat', requestId: crypto.randomUUID(), conversationId: pgState?.id, action, ...extra }, reply => { replies.push(reply); if (reply.type === 'playground_chat_state') pgState = reply.state; });
	const error = replies.find(reply => reply.type === 'playground_chat_error'); if (error) throw Error(error.error);
	return replies;
};
const attachPlayground = () => { playground = new PlaygroundChat(root); playground.subscribe(event => { if (event.type === 'playground_chat_state') pgState = event.state; }); };
const nodeFile = name => JSON.parse(readFileSync(join(root, 'nodes', name, 'omp-session.json'), 'utf8')).file;
const pgFile = () => { const saved = JSON.parse(readFileSync(join(root, 'omp/playground-chat/state.json'), 'utf8')); return saved.history.find(entry => entry.id === saved.current).sessionFile; };
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ modelRoles: { default: 'fixture/fixture' }, skills: { enabled: false }, retry: { enabled: true, baseDelayMs: 5000, maxRetries: 2 }, compaction: { enabled: false, asyncEnabled: false, idleEnabled: false, keepRecentTokens: 16, reserveTokens: 128 }, cacheWarming: { enabled: false } }));
	let a = await createNode('a'); const b = await createNode('b');
	attachPlayground(); await pg('open');
	await b.prompt('HOLD_PEER'); await wait(() => holds.has('HOLD_PEER'), 'independent node starts');
	mode = 'retry'; await a.prompt('Trigger node retry');
	await wait(() => a.snapshot().recovery?.retry, 'SSH retry projection');
	const retry = a.snapshot().recovery.retry;
	assert(retry.remainingMs > 0); assert(!('deadline' in retry));
	await new Promise(resolve => setTimeout(resolve, 60)); assert(a.snapshot().recovery.retry.remainingMs < retry.remainingMs, 'snapshot ages the native remaining duration');
	await assert.rejects(b.cancelRecovery(retry.id)); await assert.rejects(a.cancelRecovery('stale'));
	await assert.rejects(pg('cancel_recovery', { operationId: retry.id }));
	await a.cancelRecovery(retry.id); await wait(() => !a.snapshot().running && !a.snapshot().recovery?.retry, 'SSH cancellation settles');
	assert(b.snapshot().running, 'cancellation is isolated to its node');
	await a.abort(); const stopped = requests;
	await assert.rejects(a.cancelRecovery(retry.id)); assert.equal(a.session.generation, undefined); assert.equal(requests, stopped);
	await pg('send', { text: 'Trigger Playground retry', context });
	await wait(() => pgState.recovery?.retry, 'Playground retry projection');
	const pgRetry = pgState.recovery.retry.id;
	await assert.rejects(pg('cancel_recovery', { conversationId: 'foreign', operationId: pgRetry }));
	await assert.rejects(pg('cancel_recovery', { operationId: retry.id }));
	assert.equal(pgState.recovery.retry.id, pgRetry);
	await pg('cancel_recovery', { operationId: pgRetry }); await wait(() => !pgState.running && !pgState.recovery?.retry, 'Playground cancellation settles');
	await pg('stop'); const pgStopped = requests;
	await assert.rejects(pg('cancel_recovery', { operationId: pgRetry })); await pg('stop');
	assert.equal(playground.session.generation, undefined, 'cancel and Stop cannot open a stopped worker'); assert.equal(requests, pgStopped);
	mode = 'normal';
	for (let i = 0; i < 3; i++) {
		await a.prompt(`ORIGINAL_A history ${i}: ` + 'context '.repeat(200)); await wait(() => !a.snapshot().running, 'node history');
		const before = pgState.messages.filter(message => message.role === 'assistant').length;
		await pg('send', { text: `ORIGINAL_P history ${i}: ` + 'context '.repeat(200), context }); await wait(() => !pgState.running && pgState.messages.filter(message => message.role === 'assistant').length > before, 'Playground history');
	}
	// Invoke the real native operation to stimulate recovery; public business
	// controls and transmitted snapshots are the surfaces under assertion.
	for (const kind of ['node', 'playground']) {
		mode = 'hang'; const session = kind === 'node' ? a.session : playground.session;
		const compact = session.command('compact').then(() => 'complete', () => 'aborted');
		const view = () => kind === 'node' ? a.snapshot() : pgState;
		await wait(() => view().recovery?.compaction && holds.has('compaction'), `${kind} compaction`);
		const operation = view().recovery.compaction;
		assert.equal(operation.reason, 'manual');
		assert.equal(kind === 'node' ? a.busy : playground.busy, true, `${kind} compaction remains busy for update drain`);
		if (kind === 'node') await a.cancelRecovery(operation.id); else await pg('cancel_recovery', { operationId: operation.id });
		await compact; await wait(() => view().recovery?.lastCompaction?.status === 'aborted' && !view().running, `${kind} compact cancelled`);
		assert(b.snapshot().running);
	}
	mode = 'normal';
	for (const kind of ['node', 'playground']) {
		if (kind === 'node') await a.prompt('HOLD_FAILURE'); else await pg('send', { text: 'HOLD_FAILURE', context });
		await wait(() => holds.has('HOLD_FAILURE'), `${kind} streaming before external history edit`);
		const file = kind === 'node' ? nodeFile('a') : pgFile(), before = readFileSync(file, 'utf8');
		const marker = kind === 'node' ? 'ORIGINAL_A' : 'ORIGINAL_P'; assert(before.includes(marker));
		writeFileSync(file, before.replace(marker, kind === 'node' ? 'ALTERED__A' : 'ALTERED__P'));
		const view = () => kind === 'node' ? a.snapshot() : pgState;
		await wait(() => view().sessionPersistence?.externallyModified && !view().running, `${kind} persistence restriction`);
		const count = requests;
		if (kind === 'node') { await assert.rejects(a.prompt('Must reject')); await a.reopen(); }
		else { await assert.rejects(pg('send', { text: 'Must reject', context })); await pg('reopen'); }
		await wait(() => !view().sessionPersistence?.failed, `${kind} explicit recovery`); assert.equal(requests, count, 'reopen never replays');
		assert(JSON.stringify(view().messages).includes(kind === 'node' ? 'ALTERED__A' : 'ALTERED__P'));
		assert(b.snapshot().running);
	}
	// Missing saved history remains restricted across business-adapter restart.
	for (const kind of ['node', 'playground']) {
		if (kind === 'node') await a.prompt('HOLD_FAILURE'); else await pg('send', { text: 'HOLD_FAILURE', context });
		await wait(() => holds.has('HOLD_FAILURE'), `${kind} hold before missing history`);
		const file = kind === 'node' ? nodeFile('a') : pgFile(), saved = readFileSync(file);
		rmSync(file);
		await wait(() => (kind === 'node' ? a.snapshot() : pgState).sessionPersistence?.failed && !(kind === 'node' ? a.snapshot() : pgState).running, `${kind} missing history`);
		if (kind === 'node') { await a.close(); a = await createNode('a'); }
		else { await playground.close(); attachPlayground(); await pg('open'); }
		const view = () => kind === 'node' ? a.snapshot() : pgState;
		assert(view().sessionPersistence?.failed); assert.equal(existsSync(file), false, 'restart must not replace missing protected history');
		const count = requests; writeFileSync(file, saved);
		if (kind === 'node') await a.reopen(); else await pg('reopen');
		await wait(() => !view().sessionPersistence?.failed, `${kind} restored history`); assert.equal(requests, count);
	}
	assert(events.some(state => state.recovery?.retry)); assert(events.some(state => state.recovery?.compaction));
	const closing = b.close(); assert.equal(b.busy, true, 'SSH cleanup remains busy until native disposal completes');
	await closing; assert.equal(b.busy, false, 'completed SSH cleanup no longer blocks update');
	console.log('PASS restricted OMP recovery: native retry/compaction, aged snapshots, scoped cancellation, Stop isolation, external/missing history, adapter restart and explicit non-replaying reopen');
} finally {
	await Promise.allSettled([...nodes.map(node => node.close()), playground?.close()]);
	provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
