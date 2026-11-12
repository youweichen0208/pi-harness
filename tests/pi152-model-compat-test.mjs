/** Pi 1.5.2 native transport contracts through local HTTP endpoints, zero paid calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { listenIsolated } from './lib/isolated-server.mjs';

const directory = mkdtempSync(join(tmpdir(), 'pi152-compat-'));
const requests = [];
const mock = createServer(async (req, res) => {
	let body = ''; for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body); requests.push(payload);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	if (req.url.includes('/messages')) {
		const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		event('message_start', { message: { id: `reply-${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } });
		event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
		event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } });
		event('content_block_stop', { index: 0 });
		event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
		event('message_stop', {}); res.end();
	} else {
		for (const choice of [{ index: 0, delta: { content: 'OK' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [choice] })}\n\n`);
		res.end('data: [DONE]\n\n');
	}
});
let runtime;
try {
	const port = await listenIsolated(mock);
	const provider = (api, compat) => ({ api, baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture-only', models: [{ id: 'fixture', contextWindow: 32000, maxTokens: 1000, compat }] });
	writeFileSync(join(directory, 'models.json'), JSON.stringify({ providers: {
		default: provider('openai-completions'),
		enabled: provider('openai-completions', { requiresNonNullAssistantContent: true, requiresToolsWithToolHistory: true, promptCacheKeyMode: 'enabled' }),
		disabled: provider('openai-completions', { requiresNonNullAssistantContent: false, requiresToolsWithToolHistory: false, promptCacheKeyMode: 'disabled' }),
		threads: provider('anthropic-messages', { supportsMessageThreads: true }),
		noThreads: provider('anthropic-messages', { supportsMessageThreads: false }),
	} }));
	runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json'), allowModelNetwork: false });
	const user = content => ({ role: 'user', content, timestamp: Date.now() });
	for (const id of ['default', 'enabled', 'disabled']) {
		const model = runtime.getModel(id, 'fixture'); assert(model);
		const history = [user('Use a tool'), { role: 'assistant', api: 'openai-completions', provider: id, model: 'fixture', content: [{ type: 'toolCall', id: 'call-1', name: 'lookup', arguments: {} }], stopReason: 'toolUse', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, { role: 'toolResult', toolCallId: 'call-1', toolName: 'lookup', content: [{ type: 'text', text: 'found' }], isError: false, timestamp: Date.now() }];
		const result = await runtime.complete(model, { messages: history }, { sessionId: `fixture-${id}`, cacheRetention: 'short' });
		assert.equal(result.stopReason, 'stop', result.errorMessage);
		const payload = requests.at(-1);
		assert.equal(payload.messages.find(message => message.role === 'assistant').content, id === 'enabled' ? '' : null);
		if (id === 'enabled') { assert.deepEqual(payload.tools, []); assert(payload.prompt_cache_key); }
		else { assert(!Object.hasOwn(payload, 'tools')); assert(!Object.hasOwn(payload, 'prompt_cache_key')); }
	}
	const model = runtime.getModel('threads', 'fixture'), messages = [user('First')];
	let systemPrompt = 'Initial system';
	const options = { sessionId: 'thread-fixture', cacheRetention: 'short' };
	let result = await runtime.complete(model, { messages, systemPrompt }, options);
	assert.equal(result.stopReason, 'stop', result.errorMessage); assert.deepEqual(requests.at(-1).thread, { type: 'create' });
	messages.push(result, user('Second'));
	result = await runtime.complete(model, { messages, systemPrompt }, options);
	assert.equal(result.stopReason, 'stop', result.errorMessage);
	assert.equal(requests.at(-1).thread.type, 'continue'); assert.equal(requests.at(-1).messages.length, 1); assert(!Object.hasOwn(requests.at(-1), 'system'));
	messages.push(result, user('Third')); systemPrompt = 'Changed system';
	result = await runtime.complete(model, { messages, systemPrompt }, options);
	assert.equal(result.stopReason, 'stop', result.errorMessage);
	assert.equal(requests.at(-1).thread.type, 'create'); assert.equal(requests.at(-1).messages.length, messages.length);
	messages.push(result, user('Fourth'));
	const tools = [{ name: 'lookup', description: 'Find fixture', parameters: { type: 'object', properties: {} } }];
	result = await runtime.complete(model, { messages, systemPrompt, tools }, options);
	assert.equal(result.stopReason, 'stop', result.errorMessage);
	assert.equal(requests.at(-1).thread.type, 'create'); assert.equal(requests.at(-1).messages.length, messages.length);
	messages.push(result, user('Fifth')); messages[0] = user('Edited first message');
	result = await runtime.complete(model, { messages, systemPrompt, tools }, options);
	assert.equal(result.stopReason, 'stop', result.errorMessage);
	assert.equal(requests.at(-1).thread.type, 'create'); assert.equal(requests.at(-1).messages.length, messages.length);
	result = await runtime.complete(runtime.getModel('noThreads', 'fixture'), { messages: [user('Disabled')] }, { sessionId: 'disabled-thread-fixture' });
	assert.equal(result.stopReason, 'stop', result.errorMessage); assert(!Object.hasOwn(requests.at(-1), 'thread'));
	console.log('PASS native Pi 1.5.2 compatibility: null/empty content, tools history, cache keys, message threads and full-history fallback after history/system/tool changes');
} finally {
	await runtime?.settleCredentialWrites(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); rmSync(directory, { recursive: true, force: true });
}
