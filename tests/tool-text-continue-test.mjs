/** OMP never executes tool descriptions or replays a settled request automatically.
 * The historical filename stays in the full smoke manifest; Pi's one-reminder
 * policy was intentionally retired. Actual protocol tool calls still execute. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { mergeSnapshot } from './lib/snapshots.mjs';

const LEAKED = '先验证改动。</think>\n<parameter name="command">echo UNEXECUTED > must-not-exist.txt</parameter>\n</invoke>';
const DESCRIBED = '<tool_call>{"name":"write","arguments":{"path":"must-not-exist.txt","content":"UNEXECUTED"}}</tool_call>';
for (const api of ['openai-completions', 'anthropic-messages']) {
	const root = mkdtempSync(join(tmpdir(), 'omp-tool-text-'));
	const cwd = join(root, 'workspace'), data = join(root, 'data'), agent = join(data, 'omp/agent');
	mkdirSync(cwd); mkdirSync(agent, { recursive: true });
	writeFileSync(join(cwd, 'fixture.txt'), 'REAL_TOOL_RESULT_SENTINEL');
	const requests = []; let replies = [], unexpected = 0, state, harness, socket;
	const events = [];
	const model = createServer(async (req, res) => {
		let raw = ''; for await (const part of req) raw += part;
		requests.push(JSON.parse(raw));
		const reply = replies.shift() ?? (unexpected++, { text: 'UNEXPECTED_AUTOMATIC_REQUEST' });
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		if (api === 'openai-completions') {
			const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
			if (reply.tool) {
				emit({ role: 'assistant', tool_calls: [{ index: 0, id: `read-${requests.length}`, type: 'function', function: { name: 'read', arguments: '{"path":' } }] });
				emit({ tool_calls: [{ index: 0, function: { arguments: '"fixture.txt"}' } }] });
			} else for (const text of [reply.text.slice(0, 17), reply.text.slice(17)]) emit({ content: text });
			emit({}, reply.tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
		} else {
			const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
			emit('message_start', { message: { id: `m-${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
			emit('content_block_start', { index: 0, content_block: reply.tool ? { type: 'tool_use', id: `read-${requests.length}`, name: 'read', input: {} } : { type: 'text', text: '' } });
			for (const text of reply.tool ? ['{"path":', '"fixture.txt"}'] : [reply.text.slice(0, 17), reply.text.slice(17)]) emit('content_block_delta', { index: 0, delta: reply.tool ? { type: 'input_json_delta', partial_json: text } : { type: 'text_delta', text } });
			emit('content_block_stop', { index: 0 });
			emit('message_delta', { delta: { stop_reason: reply.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
			emit('message_stop', {}); res.end();
		}
	});
	const wait = async (fn, label) => {
		for (let i = 0; i < 1000; i++) { if (fn()) return; await sleep(25); }
		throw Error(`${api}: timed out ${label}; calls=${requests.length}; replies=${replies.length}; state=${JSON.stringify({running: state?.isStreaming, messages: state?.messages, notices: events.filter(e => e.type === "notice")})}\n${harness?.logs}`);
	};
	const send = value => socket.send(JSON.stringify(value));
	const run = async (text, responses) => {
		assert.equal(replies.length, 0); replies = [...responses];
		const before = requests.length, expected = before + responses.length, requestId = crypto.randomUUID();
		send({ type: 'prompt', text, requestId, target: { cwd, conversationId: state.conversationId, sessionId: state.sessionId } });
		await wait(() => requests.length >= expected && !state.isStreaming && state.messages.some(m => m.role === 'assistant' && m.content.map(b => b.text ?? b.thinking ?? '').join('').replaceAll('</think>', '') === responses.at(-1).text.replaceAll('</think>', '')), 'settled native reply');
		await wait(() => events.some(e => e.type === 'prompt_result' && e.requestId === requestId && e.receipt === 'accepted'), 'receipt');
		await sleep(750);
		assert.equal(requests.length, expected, 'no automatic replay after the final response');
		assert.equal(unexpected, 0); assert.equal(replies.length, 0);
		assert(!existsSync(join(cwd, 'must-not-exist.txt')), 'textual commands never cause file side effects');
		assert(!state.messages.some(m => m.origin === 'auto-reminder'));
	};
	try {
		const port = await listenIsolated(model);
		writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api, baseUrl: `http://127.0.0.1:${port}`, apiKey: 'FIXTURE_ONLY', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
		writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
		harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data } });
		socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
		socket.on('message', raw => { const event = JSON.parse(raw); events.push(event); state = mergeSnapshot(state, event); });
		await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
		send({ type: 'hello', clientId: `tool-text-${api}` }); await wait(() => events.some(e => e.type === 'ready'), 'ready');
		if (state.model?.id !== 'fixture') send({ type: 'set_model', modelId: 'fixture/fixture' }); await wait(() => state.model?.id === 'fixture', 'model');
		await run('First textual command', [{ text: LEAKED }]);
		if (api === 'openai-completions') assert(state.messages.some(m => m.role === 'assistant' && m.content.some(b => b.type === 'thinking' && b.thinking === '先验证改动。')), 'native leaked-thinking split is preserved');
		await run('Another textual tool description', [{ text: DESCRIBED }]);
		assert(!state.messages.some(m => m.role === 'toolResult'), 'text descriptions create no tool result');
		assert(!state.messages.some(m => m.content.some(b => b.type === 'toolCall')), 'text descriptions create no tool call');
		await run('Explicitly read fixture.txt', [{ tool: true }, { text: `After real tool progress: ${LEAKED}` }]);
		assert(requests.some(r => JSON.stringify(r.messages).includes('REAL_TOOL_RESULT_SENTINEL')), 'real streamed tool parameters execute and results return to the model');
		assert(state.messages.some(m => m.role === 'toolResult' && JSON.stringify(m).includes('REAL_TOOL_RESULT_SENTINEL')));
		const file = state.sessionFile, sessionId = state.sessionId, calls = requests.length;
		send({ type: 'abort' });
		const status = async () => (await (await fetch(`http://127.0.0.1:${harness.port}/api/system-prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: `tool-text-${api}`, cwd, conversationId: state.conversationId, action: 'get' }) })).json()).available;
		for (let i = 0; await status() && i < 400; i++) await sleep(25);
		assert.equal(await status(), false); assert.equal(requests.length, calls);
		await run('Explicit user continuation', [{ text: 'NORMAL_FINAL_ANSWER' }]);
		assert.equal(state.sessionFile, file); assert.equal(state.sessionId, sessionId);
		const history = readFileSync(file, 'utf8');
		assert(history.includes('must-not-exist.txt')); assert(!history.includes('auto-reminder'));
		assert(JSON.stringify(requests.at(-1).messages).includes('must-not-exist.txt'), 'original textual description remains in restored model history');
		console.log(`PASS ${api}: textual tools remain text, no automatic replay before/after real tools, split parameters execute, Stop and explicit continuation preserve history`);
	} finally {
		socket?.terminate(); await harness?.stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); rmSync(root, { recursive: true, force: true });
	}
}
