/** Real OMP recovery over a local provider. No external accounts or model calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOmpTestModule } from './lib/omp-runtime-location.mjs';
import { listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const { OmpSession } = await loadOmpTestModule('session.js');
const root = mkdtempSync(join(tmpdir(), 'omp-recovery-')), agent = join(root, 'omp', 'agent');
mkdirSync(agent, { recursive: true });
let mode = 'normal', requests = 0;
const sessions = [], observed = [];
const env = testEnv();
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete env[key];
const provider = createServer(async (req, res) => {
	for await (const _ of req) { /* consume request */ }
	requests++;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `m-${requests}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	if (mode === 'hang') return;
	if (mode === 'retry') {
		// A thinking delta leaves the provider's pre-output retry wrapper while
		// remaining replay-safe for the native session retry policy.
		emit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
		emit('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture reasoning' } });
		emit('content_block_stop', { index: 0 });
		emit('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }); res.end(); return;
	}
	emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'The fixture conversation tests context maintenance. Earlier messages supplied project context; no files were changed. The remaining work is to validate cancellation, retain the current session settings, and continue only when the user submits another request.' } });
	emit('content_block_stop', { index: 0 });
	emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } });
	emit('message_stop', {}); res.end();
});
const wait = async (fn, label) => {
	for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); }
	throw Error(`Timed out: ${label}; requests=${requests}; events=${JSON.stringify(observed.slice(-8))}`);
};
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 200000 }] } } }));
	const config = JSON.stringify({ skills: { enabled: false }, retry: { enabled: false, baseDelayMs: 5000, maxRetries: 2 }, compaction: { enabled: false, asyncEnabled: false, idleEnabled: false, keepRecentTokens: 16, reserveTokens: 128 }, cacheWarming: { enabled: false } });
	writeFileSync(join(agent, 'config.yml'), config);
	for (const id of ['a', 'b']) {
		const session = new OmpSession({ conversationId: id, dataDir: root, cwd: root, env, model: 'fixture/fixture', restricted: { systemPrompt: 'Reply with a brief summary.', toolNames: [] }, onChange() {}, onEvent: event => { if (event.frame.type === 'harness_recovery' || event.frame.type.includes('compaction_')) observed.push({ id, ...event.frame }); else if (['message_end', 'prompt_result', 'auto_retry_start', 'auto_retry_end'].includes(event.frame.type)) observed.push({ id, type: event.frame.type, error: event.frame.message?.errorMessage, stopReason: event.frame.message?.stopReason, status: event.frame.status }); } });
		sessions.push(session); await session.open();
	}
	const [a, b] = sessions;
	await a.setRunSettings({ autoRetry: true, autoCompaction: true });
	assert.deepEqual(a.state.runSettings, { autoRetry: true, autoCompaction: true });
	assert.deepEqual(b.state.runSettings, { autoRetry: false, autoCompaction: false });
	assert.equal(readFileSync(join(agent, 'config.yml'), 'utf8'), config);
	await a.command('harness_reload'); await a.refresh();
	assert.equal(a.state.runSettings.autoRetry, true, 'reload retains the session override');
	mode = 'retry'; await a.prompt('Trigger native retry');
	await wait(() => a.state.recovery?.retry, 'native retry starts');
	const retry = a.state.recovery.retry.id;
	assert(a.recoverySnapshot().retry.remainingMs > 0);
	assert(!('deadline' in a.recoverySnapshot().retry));
	await assert.rejects(b.cancelRecovery(retry));
	await assert.rejects(a.cancelRecovery('stale'));
	assert.equal(a.state.recovery.retry.id, retry);
	await a.cancelRecovery(retry);
	await wait(() => !a.state.recovery?.retry && !a.state.running, 'retry cancellation settles');
	const cancelledRequests = requests;
	await a.stop(); await a.open();
	assert.equal(requests, cancelledRequests, 'stop/reopen does not retry');
	assert.equal(a.state.runSettings.autoRetry, true, 'stop/reopen retains the session override');
	await assert.rejects(a.cancelRecovery(retry));
	mode = 'normal'; await a.setRunSettings({ autoRetry: false, autoCompaction: false });
	for (let i = 0; i < 3; i++) { await a.prompt(`History ${i}: ` + 'fixture context '.repeat(200)); await wait(() => !a.state.running, 'history turn'); }
	mode = 'hang';
	const compaction = a.command('compact').then(() => 'completed', () => 'cancelled');
	await wait(() => a.state.recovery?.compaction && requests > cancelledRequests + 3, 'manual compaction enters provider');
	const operation = a.state.recovery.compaction.id;
	assert.equal(a.state.recovery.compaction.reason, 'manual');
	await assert.rejects(a.cancelRecovery(retry));
	await a.cancelRecovery(operation); await compaction;
	await wait(() => a.state.recovery?.lastCompaction?.status === 'aborted' && !a.state.running, 'manual cancellation outcome');
	mode = 'normal';
	await a.command('compact'); await a.refresh();
	assert.equal(a.state.recovery.lastCompaction.status, 'completed');
	assert(a.state.messages.some(message => message.role === 'compactionSummary'), 'native summary remains visible in the UI projection');
	assert.notEqual(a.state.recovery.lastCompaction.id, operation);
	await a.setRunSettings({ autoRetry: true });
	mode = 'retry'; await a.prompt('Stop during the retry wait');
	await wait(() => a.state.recovery?.retry, 'second native retry starts');
	const stoppedOperation = a.state.recovery.retry.id;
	await a.stop();
	assert.equal(a.recoverySnapshot()?.retry, undefined, 'Stop clears recovery controls for the closed worker');
	assert.equal(a.state.running, false);
	const stoppedRequests = requests;
	await assert.rejects(a.cancelRecovery(stoppedOperation));
	await a.open();
	assert.equal(requests, stoppedRequests, 'reopen does not resume the stopped retry');
	assert.equal(a.state.runSettings.autoRetry, true);
	assert.equal(readFileSync(join(agent, 'config.yml'), 'utf8'), config);
	console.log('PASS native OMP retry/compaction lifecycle, cancellation IDs, session isolation and settings across reload/reopen');
} catch (error) {
	console.error(JSON.stringify({ requests, observed: observed.slice(-15) })); throw error;
} finally {
	await Promise.allSettled(sessions.map(session => session.close()));
	provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
