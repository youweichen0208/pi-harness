import { mergeSnapshot } from "./lib/snapshots.mjs";
/** Real OMP + local Anthropic/OpenAI streams; no external model requests. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { ompTestRoot, ompTestExecutable, ompTestPackaged } from './lib/omp-runtime-location.mjs';

const repetition = 'LOOP_FIXTURE Emit. Write tool call. Now. Ok, output. Emit.\n';
const validThinking = Array.from({ length: 180 }, (_, i) => `NORMAL_THINK_${i}: file ${i}, result ${i * 7}. `).join('');
for (const api of ['anthropic-messages', 'openai-completions']) {
	const root = mkdtempSync(join(tmpdir(), 'omp-repetition-'));
	const data = join(root, 'data'), agent = join(data, 'omp', 'agent'), cwd = join(root, 'project'), diagnostics = join(root, 'diagnostics');
	for (const path of [agent, cwd]) mkdirSync(path, { recursive: true });
	writeFileSync(join(cwd, 'fixture.txt'), 'TOOL_RESULT_FIXTURE');
	let releaseLoop, foreground, emitted = 0, stopped = false, harness, ws, poll, state;
	const loopGate = new Promise(resolve => { releaseLoop = resolve; });
	const requests = [], events = [];
	const anthropic = api === 'anthropic-messages';
	function stream(res) {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
		const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
		if (anthropic) event('message_start', { message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
		else chunk({ role: 'assistant' });
		let index = 0;
		return {
			startThinking() { if (anthropic) event('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } }); },
			think(text) { if (anthropic) event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: text } }); else chunk({ reasoning_content: text }); },
			endThinking() {
				if (anthropic) { event('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'VALID_NATIVE_SIGNATURE' } }); event('content_block_stop', { index }); }
				index++;
			},
			text(text) {
				if (anthropic) { event('content_block_start', { index, content_block: { type: 'text', text: '' } }); event('content_block_delta', { index, delta: { type: 'text_delta', text } }); event('content_block_stop', { index }); }
				else chunk({ content: text }); index++;
			},
			tool() {
				if (anthropic) {
					event('content_block_start', { index, content_block: { type: 'tool_use', id: 'read-1', name: 'read', input: {} } });
					for (const part of ['{"pa', 'th":"fixture', '.txt"}']) event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: part } });
					event('content_block_stop', { index });
				} else {
					chunk({ tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: '' } }] });
					for (const part of ['{"pa', 'th":"fixture', '.txt"}']) chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] });
				} index++;
			},
			finish(reason = 'stop') {
				if (anthropic) { event('message_delta', { delta: { stop_reason: reason === 'length' ? 'max_tokens' : reason === 'tool' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } }); event('message_stop', {}); }
				else { chunk({}, reason === 'tool' ? 'tool_calls' : reason); res.write('data: [DONE]\n\n'); }
				res.end();
			},
		};
	}
	const mock = createServer(async (req, res) => {
		let raw = ''; for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw); requests.push(body);
		const tail = JSON.stringify(body.messages.at(-1));
		const output = stream(res);
		if (tail.includes('PROSE_REQUEST')) { output.text('Repeated answer text. '.repeat(300)); output.finish(); }
		else if (tail.includes('REPEAT_REQUEST')) {
			res.on('close', () => { stopped = true; });
			output.startThinking(); await loopGate;
			for (let i = 0; i < 400 && !res.destroyed; i++) { output.think(repetition); emitted++; await sleep(5); }
			if (!res.destroyed) { output.endThinking(); output.text('NATIVE_GUARD_DISABLED_COMPLETE'); output.finish(); }
		} else if (tail.includes('FOREGROUND_HOLD')) foreground = output;
		else if (tail.includes('NORMAL_TOOL')) {
			output.startThinking(); output.think(validThinking); output.endThinking(); output.tool(); output.finish('tool');
		} else if (tail.includes('LIMIT_REQUEST')) {
			output.startThinking(); output.think('Thinking within the native output budget.'); output.endThinking(); output.finish('length');
		} else { output.text('RECOVERED ' + 'Repeated answer text. '.repeat(200)); output.finish(); }
	});
	const wait = async (test, label) => { for (let i = 0; i < 800; i++) { if (test()) return; await sleep(40); } throw Error(`Timed out ${api}: ${label}; ${events.slice(-4).map(e => e.type)}; ${harness?.logs.slice(-1500)}`); };
	const send = value => ws.send(JSON.stringify(value));
	const prompt = (text, queue) => send({ type: 'prompt', text, queue, requestId: randomUUID(), target: { cwd: state.cwd, conversationId: state.conversationId, sessionId: state.sessionId } });
	try {
		const port = await listenIsolated(mock);
		writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'SECRET_DIAGNOSTIC_FIXTURE', models: [{ id: 'fixture', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 128000 }] } } }));
		const config = { skills: { enabled: false }, retry: { enabled: true }, model: { loopGuard: { checkAssistantContent: false } }, compaction: { enabled: false }, cacheWarming: { enabled: false } };
		writeFileSync(join(agent, 'config.yml'), JSON.stringify(config));
		harness = await startIsolatedHarness({ executable: ompTestExecutable, args: [join(ompTestRoot, 'dist/server/index.js')], env: { PI_WEB_DATA_DIR: data, PI_WEB_CWD: cwd, PI_WEB_PKG_ROOT: ompTestRoot, PI_WEB_MODEL_DIAGNOSTICS_DIR: diagnostics, ...(ompTestPackaged ? { ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '', NODE_OPTIONS: '' } : {}) } });
		ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
		ws.on('message', raw => { const event = JSON.parse(raw); events.push(event); state = mergeSnapshot(state, event); });
		await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
		send({ type: 'hello', clientId: randomUUID() });
		poll = setInterval(() => { if (ws.readyState === WebSocket.OPEN) send({ type: 'get_state' }); }, 100);
			await wait(() => events.some(e => e.type === 'ready') && state?.model?.id === 'fixture', 'initial fixture model');
			// The fixture is already selected at ready. Re-selecting it and testing
			// that same snapshot does not await the asynchronous settings command.
		const savedConfig = readFileSync(join(agent, 'config.yml'), 'utf8');
		const originalId = state.conversationId;
		prompt('REPEAT_REQUEST'); await wait(() => requests.length === 1 && state.isStreaming, 'thinking stream starts');
		prompt('MUST_NOT_REPLAY', 'followUp'); await wait(() => state.queue.followUp.length === 1, 'queued request admitted');
		send({ type: 'new_chat' }); await wait(() => state.conversationId !== originalId && state.model?.id === 'fixture' && !state.isStreaming, 'foreground conversation');
		const foregroundId = state.conversationId;
		prompt('FOREGROUND_HOLD'); await wait(() => foreground && state.isStreaming, 'foreground stream starts');
		releaseLoop();
		await wait(() => stopped && events.some(e => e.type === 'notice' && e.conversationId === originalId && /重复/.test(e.text)), 'background watchdog stop');
		await wait(() => events.findLast(e => e.type === 'conversations')?.conversations.some(c => c.id === originalId && !c.isStreaming), 'background run settled');
		assert.equal(state.conversationId, foregroundId); assert.equal(state.isStreaming, true, 'sibling model stream survives');
		foreground.text('FOREGROUND_DONE'); foreground.finish();
		await wait(() => !state.isStreaming && JSON.stringify(state.messages).includes('FOREGROUND_DONE'), 'foreground normal completion');
		send({ type: 'switch_conversation', id: originalId });
		await wait(() => state.conversationId === originalId && !state.isStreaming && state.messages.some(m => m.role === 'assistant'), 'interrupted transcript');
		assert(emitted < 400, 'stop before synthetic repetition stream ends');
		assert.match(state.errorMessage, /重复/);
		assert(state.messages.some(m => m.stopReason === 'error'), 'native loop error remains visible, never success');
		assert.equal(state.queue.followUp.length, 0);
		await sleep(200); assert.equal(requests.length, 2, 'no replay of prompt or queued follow-up');
		assert.equal(readFileSync(join(agent, 'config.yml'), 'utf8'), savedConfig, 'interrupt does not change native settings');
		const sessionFile = state.sessionFile; assert(sessionFile);
		const interruptedHistory = readFileSync(sessionFile, 'utf8');
		assert(interruptedHistory.includes('Thinking loop detected'), 'native failure record is preserved');
		const continuedFrom = events.length;
		prompt('NORMAL_TOOL');
		await wait(() => events.slice(continuedFrom).some(e => e.type === 'prompt_result'), 'continuation receipt');
		assert.equal(events.slice(continuedFrom).find(e => e.type === 'prompt_result')?.ok, true, JSON.stringify(events.slice(continuedFrom).filter(e => e.type === 'prompt_result')));
		await wait(() => requests.length === 4 && !state.isStreaming && JSON.stringify(state.messages).includes('RECOVERED'), 'explicit continue with real native read');
		assert(!JSON.stringify(requests[2].messages).includes('LOOP_FIXTURE'), 'native provider excludes aborted reasoning');
		assert(JSON.stringify(requests[3].messages).includes('TOOL_RESULT_FIXTURE'), 'fragmented tool arguments executed correctly');
		if (anthropic) {
			assert(JSON.stringify(requests[3].messages).includes('NORMAL_THINK_0'), 'valid thinking survives tool-result continuation');
			assert(JSON.stringify(requests[3].messages).includes('VALID_NATIVE_SIGNATURE'), 'valid signature remains native');
		}
		assert.equal(requests[2].max_tokens ?? requests[2].max_completion_tokens, 128000, 'explicit output limit remains authoritative');
		assert.equal(events.filter(e => e.type === 'notice' && /重复/.test(e.text)).length, 1, 'normal long thinking, answer repetition and tool arguments do not interrupt');
		assert.equal(state.errorMessage, undefined);
		send({ type: 'new_chat' }); await wait(() => state.sessionFile && state.sessionFile !== sessionFile && !state.isStreaming, 'leave interrupted history');
		send({ type: 'switch_session', path: sessionFile }); await wait(() => state.sessionFile === sessionFile && !state.isStreaming, 'restore native history');
		prompt('CONTINUE_AFTER_RESTORE');
		await wait(() => requests.length === 5 && !state.isStreaming, 'restored manual continuation');
		assert(!JSON.stringify(requests[4].messages).includes('LOOP_FIXTURE'));
		assert(JSON.stringify(requests[4].messages).includes('RECOVERED'), 'completed responses remain in native context');
		assert(readFileSync(sessionFile, 'utf8').startsWith(interruptedHistory), 'original native records remain unchanged after restore');
		prompt('LIMIT_REQUEST');
		await wait(() => requests.length === 6 && !state.isStreaming && state.messages.at(-1)?.stopReason === 'length', 'native length outcome');
		assert.match(state.errorMessage, /output limit/); assert.equal(events.filter(e => e.type === 'notice' && /重复/.test(e.text)).length, 1);
			const beforeLengthRefresh = events.length;
			send({ type: 'get_state' });
			await wait(() => events.slice(beforeLengthRefresh).some(event => event.type === 'snapshot'), 'length history refresh');
			assert.equal(state.messages.at(-1)?.stopReason, 'length', 'native truncated thinking stays visible after active-context cleanup');
			assert(state.messages.some(message => message.role === 'assistant' && message.stopReason === 'error'), 'native past failure stays visible after explicit continuation');
		// Preserve native policy: disabling the guard is respected, and the native
		// default also scans prose. No second host detector overrides either choice.
		writeFileSync(join(agent, 'config.yml'), JSON.stringify({ ...config, model: { loopGuard: { enabled: false } } }));
		const oldId = state.conversationId;
		send({ type: 'new_chat' }); await wait(() => state.conversationId !== oldId && state.model?.id === 'fixture' && !state.isStreaming, 'native guard disabled session');
		prompt('REPEAT_REQUEST');
		await wait(() => !state.isStreaming && JSON.stringify(state.messages).includes('NATIVE_GUARD_DISABLED_COMPLETE'), 'disabled native guard permits completion');
		assert.equal(events.filter(e => e.type === 'notice' && /重复/.test(e.text)).length, 1);
		assert.equal(state.errorMessage, undefined);
		writeFileSync(join(agent, 'config.yml'), JSON.stringify({ ...config, model: {} }));
		const disabledId = state.conversationId;
		send({ type: 'new_chat' }); await wait(() => state.conversationId !== disabledId && state.model?.id === 'fixture' && !state.isStreaming, 'native default prose guard session');
		prompt('PROSE_REQUEST');
		await wait(() => !state.isStreaming && /重复/.test(state.errorMessage ?? ''), 'native prose guard interrupt');
		assert.equal(events.filter(e => e.type === 'notice' && /重复/.test(e.text)).length, 2);
		assert.equal(requests.length, 8, 'native prose loop is not resampled');
			assert.equal(events.filter(e => e.type === 'notice' && e.level === 'error').length, 0, 'passive reads during shutdown do not fail continuation or flood notices: ' + JSON.stringify(events.filter(e => e.type === 'notice' && e.level === 'error')));
		const files = readdirSync(diagnostics).filter(file => file.endsWith('.jsonl'));
		const logs = files.map(file => { const path = join(diagnostics, file); assert(statSync(path).size <= 8 * 1024 * 1024); return readFileSync(path, 'utf8'); });
		const records = logs.filter((log, index) => files[index].startsWith('model-events-')).flatMap(log => log.trim().split('\n').map(line => JSON.parse(line)));
		assert(files.some(file => file.startsWith('provider-events-')), 'native request diagnostics are also collected');
		assert.equal(records.filter(record => record.type === 'harness_model_loop').length, 2);
		assert(records.every(record => record.engine === 'omp' && record.scope === 'chat'));
		assert(records.some(record => record.streamType === 'thinking_delta' && record.characters > 0));
		assert(records.some(record => record.streamType === 'toolcall_delta'));
		assert(records.some(record => record.stopReason === 'error'));
		assert(records.some(record => record.stopReason === 'length'));
		assert(!logs.join('').match(/LOOP_FIXTURE|NORMAL_THINK|SECRET_DIAGNOSTIC_FIXTURE|fixture\.txt|VALID_NATIVE_SIGNATURE|REPEAT_REQUEST|TOOL_RESULT_FIXTURE/), 'no content, signature, arguments or credentials in diagnostics');
		console.log(`PASS ${api}: native loop policy, background interruption, sibling isolation, no retry/queued replay, preserved failure and valid thinking history, tools, continuation, length and private diagnostics`);
	} catch (error) {
		const records = (existsSync(diagnostics) ? readdirSync(diagnostics).filter(file => file.endsWith('.jsonl')) : []).flatMap(file => readFileSync(join(diagnostics, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
		const counts = records.reduce((summary, record) => { const key = `${record.type}/${record.streamType ?? record.stopReason ?? ''}`; summary[key] = (summary[key] ?? 0) + 1; return summary; }, {});
		console.error(JSON.stringify({ emitted, stopped, requestCount: requests.length, running: state?.isStreaming, error: state?.errorMessage,
			messageStates: state?.messages.map(message => ({ role: message.role, stopReason: message.stopReason })),
			notices: [...new Set(events.filter(e => e.type === 'notice').map(e => /^OMP [a-z_]+ command rejected$/.test(e.text) ? e.text : e.level))], diagnostics: counts }));
		throw error;
	} finally {
		releaseLoop(); clearInterval(poll); ws?.terminate(); await harness?.stop(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); rmSync(root, { recursive: true, force: true });
	}
}
