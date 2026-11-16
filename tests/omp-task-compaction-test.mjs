/** Native child compaction preserves nested Task ownership without replay or history writes. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadOmpTestModule, ompTestRoot } from './lib/omp-runtime-location.mjs';
import { listenIsolated } from './lib/isolated-server.mjs';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete process.env[key];
const { OmpClientSession } = await loadOmpTestModule('chat-service.js');
const { OmpSession } = await loadOmpTestModule('session.js');
const { readOmpToolOutput } = await loadOmpTestModule('runtime.js');
const { ClientStateStore } = await import(pathToFileURL(join(ompTestRoot, 'dist/server/client-state.js')).href);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'omp-task-compaction-'))), agent = join(root, 'omp/agent');
mkdirSync(agent, { recursive: true }); writeFileSync(join(root, 'task-evidence.txt'), 'NATIVE_CHILD_READ_EVIDENCE');
const requests = [], readers = []; let client;
const provider = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	const payload = JSON.parse(raw); requests.push(payload);
	const first = JSON.stringify(payload.messages.find(message => message.role === 'user')?.content);
	const child = first.includes('HOLD_NATIVE_CHILD') ? 'hold' : first.includes('NEST_PARENT_CHILD') ? 'nested-parent' : first.includes('FINISH_NATIVE_CHILD') ? 'finish' : undefined;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event('message_start', { message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
	const tool = (index, name, args) => {
		event('content_block_start', { index, content_block: { type: 'tool_use', id: `${name}-${requests.length}-${index}`, name, input: {} } });
		event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
		event('content_block_stop', { index });
	};
	const toolsDone = payload.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
	const taskTool = payload.tools?.find(item => item.name === 'task' || item.name === '_task');
	let toolUse = false;
	if (child === 'hold' && !toolsDone) {
		tool(0, payload.tools.find(item => item.name === 'read' || item.name === '_read').name, { path: join(root, 'task-evidence.txt') }); toolUse = true;
	} else if (child === 'nested-parent' && !toolsDone && taskTool) {
		const item = { name: 'grandchild', task: 'HOLD_NATIVE_CHILD: read task-evidence.txt and wait.', solutionSpace: 'Read only; no edits or further delegation.' };
		tool(0, taskTool.name, taskTool.input_schema.properties?.tasks ? { context: 'Nested fixture.', tasks: [item] } : item); toolUse = true;
	} else if (!child && !toolsDone && first.includes('START_NATIVE_TASKS') && taskTool) {
		const tasks = [
			{ name: 'hold-child', task: 'NEST_PARENT_CHILD: delegate a read to a nested child.', solutionSpace: 'Read only; no edits.' },
			{ name: 'finish-child', task: 'FINISH_NATIVE_CHILD: reply with the final result.', solutionSpace: 'Reply directly, no tools or edits.' },
		];
		const schema = taskTool.input_schema;
		if (schema.properties?.tasks) tool(0, taskTool.name, { context: 'Independent fixture subtasks.', tasks });
		else tasks.forEach((item, index) => tool(index, taskTool.name, item));
		toolUse = true;
	} else {
		event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
		event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: child ? 'CHILD_RESULT_COMPLETE' : 'PARENT_RESULT_COMPLETE' } });
		event('content_block_stop', { index: 0 });
	}
	event('message_delta', { delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 12 } }); event('message_stop', {}); res.end();
});
const wait = async (check, label) => { for (let i = 0; i < 1500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error(`Timed out ${label}: ${JSON.stringify(client?.session.taskSnapshot())}; requests=${JSON.stringify(requests.map(p => ({ user: p.messages.find(m => m.role === 'user')?.content, tools: p.tools?.map(t => t.name) }))).slice(0, 6000)}; ${JSON.stringify(client?.session.state.messages).slice(-5000)}`); };
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'SECRET_NATIVE_TASK', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false }, task: { isolation: false } }));
	client = new OmpClientSession('tasks', root, new ClientStateStore(join(root, 'client-state.json'))); client.attachSink(() => {}, false);
	await client.initialize(); await client.setModel('fixture/fixture');
	const session = client.session;
	await client.prompt('START_NATIVE_TASKS');
	await wait(() => !session.state.running && session.taskSnapshot().length === 3 && session.taskSnapshot().every(task => task.status === 'completed'), 'nested tasks complete');
	const before = session.taskSnapshot();
	const parent = before.find(task => task.task?.includes('NEST_PARENT_CHILD')); assert(parent);
	const mainFile = session.state.sessionFile;
	const childFile = session.taskOutputPath(parent.id).reduce((file, step) => join(file.slice(0, -6), `${step.nativeId}.jsonl`), mainFile);
	await client.dispose(); client = undefined;
	const requestCount = requests.length;
	const bun = join(ompTestRoot, 'node_modules/bun/bin/bun.exe');
	const mutate = async (file, mode = 'compact', leaf = '') => {
		const result = await promisify(execFile)(bun, [fileURLToPath(new URL('./fixtures/omp-task-compaction.mjs', import.meta.url)), file, mode, leaf, ompTestRoot], {
			cwd: root, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ELECTRON_RUN_AS_NODE: undefined, PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: relative(homedir(), join(root, 'native-config')) }, timeout: 30000,
		});
		return JSON.parse(result.stdout);
	};
	const hashes = () => Object.fromEntries(readdirSync(root, { recursive: true }).filter(file => file.endsWith('.jsonl')).sort().map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]));
	const verify = async (count, label) => {
		const original = hashes(), rootBefore = readFileSync(mainFile, 'utf8');
		const reader = new OmpSession({ conversationId: 'compacted-task-reader', dataDir: root, cwd: root, sessionFile: mainFile, onChange() {} }); readers.push(reader);
		await reader.open(); const restored = reader.taskSnapshot();
		assert.equal(restored.length, count, label);
		assert(restored.every(task => task.status === 'completed' && !task.canStop));
		for (let i = 0; i < 2; i++) assert.equal((await reader.command('harness_history')).data.tasks.length, count, 'cached reads keep task ancestry');
		const grandchild = restored.find(task => task.task?.includes('HOLD_NATIVE_CHILD'));
		if (count === 3) {
			assert(grandchild);
			assert.equal(reader.taskOutputPath(grandchild.id).length, 2, 'restored output ownership includes compacted parent');
			const childDetail = await reader.taskRequest(grandchild.id, 'detail');
			const result = childDetail.messages.find(message => message.role === 'toolResult' && message.content.some(block => block.text?.includes('NATIVE_CHILD_READ_EVIDENCE'))); assert(result?.toolCallId);
			const output = await readOmpToolOutput({ dataDir: root, cwd: root, sessionFile: mainFile, outputTask: reader.taskOutputPath(grandchild.id) }, result.toolCallId);
			assert(output.text.includes('NATIVE_CHILD_READ_EVIDENCE'), 'output reader resolves the original child result through compacted ancestry');
			const parent = restored.find(task => task.task?.includes('NEST_PARENT_CHILD'));
			const detail = await reader.taskRequest(parent.id, 'detail');
			assert(!detail.messages.some(message => message.content.some(block => block.type === 'toolCall')), 'detail follows native collapsed transcript');
		} else assert(!grandchild, 'abandoned branch must not disclose nested task');
		assert.deepEqual(hashes(), original, 'task reads never rewrite any native transcript');
		await reader.close();
		const rootClosed = readFileSync(mainFile, 'utf8');
		assert(rootClosed.startsWith(rootBefore), 'closing the parent must preserve original history');
		assert(rootClosed.slice(rootBefore.length).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).every(entry => entry.type === 'custom' && entry.customType === 'session_exit'), 'native parent close may append only its session_exit metadata');
		const after = hashes(); delete after[relative(root, mainFile)]; delete original[relative(root, mainFile)];
		assert.deepEqual(after, original, 'closing the parent never writes child transcripts');
		assert.equal(requests.length, requestCount, 'restoring history never calls a model');
	};
	const compacted = await mutate(childFile);
	assert(compacted.hasCompaction && compacted.branchTaskCalls > 0 && compacted.collapsedTaskCalls === 0, 'native fixture must compact the earlier nested Task');
	await verify(3, 'child compaction must retain all nested tasks');
	const repeated = await mutate(childFile);
	await verify(3, 'repeated child compaction preserves ownership');
	const hidden = await mutate(childFile, 'hide'); assert.equal(hidden.branchTaskCalls, 0);
	await verify(2, 'moving child to another branch hides its nested task');
	await mutate(childFile, 'restore', repeated.leafId);
	await verify(3, 'restoring compacted branch restores nested task');
	// Child history is read-only in this host; simulate an explicit edit by its
	// native writer and ensure the existing metadata cache follows its new branch.
	const cached = new OmpSession({ conversationId: 'cached-task-reader', dataDir: root, cwd: root, sessionFile: mainFile, onChange() {} }); readers.push(cached);
	await cached.open();
	const catalogue = (await cached.command('harness_history')).data.tasks;
	const oldGrandchild = catalogue.find(task => task.task?.includes('HOLD_NATIVE_CHILD')); assert(oldGrandchild);
	await mutate(childFile, 'hide');
	const hiddenHashes = hashes();
	assert.equal((await cached.command('harness_history')).data.tasks.length, 2);
	await assert.rejects(cached.command('harness_task_history', { handle: oldGrandchild.historyHandle, cursor: 0 }), /OMP harness_task_history command rejected/);
	assert.deepEqual(hashes(), hiddenHashes, 'cache refresh must not write history');
	await mutate(childFile, 'restore', repeated.leafId);
	const restoredHashes = hashes();
	const refreshed = (await cached.command('harness_history')).data.tasks;
	assert.equal(refreshed.length, 3);
	const newGrandchild = refreshed.find(task => task.task?.includes('HOLD_NATIVE_CHILD')); assert(newGrandchild);
	assert.notEqual(newGrandchild.historyHandle, oldGrandchild.historyHandle, 'hidden history handle must not be reused');
	await cached.command('harness_task_history', { handle: newGrandchild.historyHandle, cursor: 0 });
	assert.deepEqual(hashes(), restoredHashes, 'restored cache stays read-only');
	await cached.close();
	await mutate(mainFile);
	await verify(3, 'compaction in both parent and child preserves nested tasks');
	console.log('PASS native Task compaction: nested catalogue, repeated compaction, selected branch isolation/restore, cache invalidation, collapsed details, output ancestry, unchanged history and no replay');

} finally { await client?.dispose(); await Promise.allSettled(readers.map(reader => reader.close())); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true }); }
