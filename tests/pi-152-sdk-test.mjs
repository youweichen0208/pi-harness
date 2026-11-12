/** Pi 1.5.2 native tool contracts. Isolated files/streams only; no model or network. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runToolCall } from '@earendil-works/pi-agent-core';
import { createReadTool, createEditTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const root = mkdtempSync(join(tmpdir(), 'pi-152-native-'));
try {
	const received = [];
	const tool = { name: 'schema_fixture', label: 'Schema fixture', description: 'Fixture', parameters: Type.Object({ count: Type.BigInt({ minimum: 1n }), absent: Type.Undefined() }), execute: async (_id, args) => {
		received.push(args); return { content: [{ type: 'text', text: 'ok' }], details: {} };
	} };
	const options = { tools: [tool], context: { systemPrompt: '', messages: [], tools: [tool] }, assistantMessage: { role: 'assistant', content: [], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 0 } };
	const args = { count: '9007199254740993', absent: 'undefined' };
	assert.equal((await runToolCall({ id: 'schema-valid', name: tool.name, type: 'toolCall', arguments: args }, options)).isError, false);
	assert.deepEqual(received, [{ count: 9007199254740993n, absent: undefined }]);
	assert.equal(args.count, '9007199254740993', 'original transcript arguments remain JSON-safe');
	for (const invalid of [{ count: '0', absent: 'undefined' }, { count: 'bad', absent: 'undefined' }, { count: '2', absent: 'present' }]) {
		assert.equal((await runToolCall({ id: 'schema-invalid', name: tool.name, type: 'toolCall', arguments: invalid }, options)).isError, true);
	}
	assert.equal(received.length, 1, 'invalid arguments never reach tool execution');
	console.log('PASS native BigInt/Undefined coercion, precision and execution boundary');

	const file = join(root, 'stream.txt');
	const contents = 'first\r\n中文🙂 boundary\nthird\r\n' + 'large file contents\n'.repeat(20000);
	writeFileSync(file, contents);
	const native = createReadTool(root);
	const selected = await native.execute('read-native', { path: file, offset: 2, limit: 2 });
	assert(selected.content[0].text.startsWith('中文🙂 boundary\nthird\r'));
	const bytes = Buffer.from(contents);
	let closed = false, buffered = false;
	const streamed = createReadTool(root, { operations: {
		access: async () => {},
		readFile: async () => { buffered = true; throw Error('must use streaming operations'); },
		createReadStream: async function* () { try { for (let start = 0; start < bytes.length; start += 13) yield bytes.subarray(start, start + 13); } finally { closed = true; } },
	} });
	assert.deepEqual(await streamed.execute('read-stream', { path: file, offset: 2, limit: 2 }), selected);
	assert(closed && !buffered, 'streaming closes and never buffers the full file');
	const bounded = await native.execute('read-bounded', { path: file });
	assert(bounded.content[0].text.length < 55000 && bounded.details.truncation.truncated);
	const controller = new AbortController(); let abortClosed = false;
	const cancellable = createReadTool(root, { operations: {
		access: async () => {}, readFile: async () => { throw Error('not reached'); },
		createReadStream: async function* () { try { yield Buffer.from('first\n'); controller.abort(); yield Buffer.from('second\n'); } finally { abortClosed = true; } },
	} });
	await assert.rejects(cancellable.execute('read-cancel', { path: file }, controller.signal), /abort/i);
	// The rejecting cancellation promise can precede the generator's finally microtask.
	await new Promise(resolve => setImmediate(resolve));
	assert(abortClosed);
	console.log('PASS native bounded file streaming, split UTF-8, ranges and cancellation cleanup');

	const mixed = '\ufeffalpha\r\nkeep LF\nold CRLF\r\nkeep tail\n';
	const target = join(root, 'mixed.txt'); writeFileSync(target, mixed);
	const edited = await createEditTool(root).execute('edit-mixed', { path: target, edits: [{ oldText: 'old CRLF', newText: 'new CRLF' }] });
	assert.equal(readFileSync(target, 'utf8'), mixed.replace('old CRLF', 'new CRLF'));
	assert(edited.details.patch.includes('+new CRLF'));
	console.log('PASS native edit preserves BOM and unchanged mixed newline bytes');
} finally { rmSync(root, { recursive: true, force: true }); }
