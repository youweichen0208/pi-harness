/** Native OMP task delegation, independent cancellation and transcript ownership. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOmpTestModule, ompTestRoot } from './lib/omp-runtime-location.mjs';
import { listenIsolated } from './lib/isolated-server.mjs';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete process.env[key];
const { OmpClientSession } = await loadOmpTestModule('chat-service.js');
const { OmpSession } = await loadOmpTestModule('session.js');
const { ClientStateStore } = await import(pathToFileURL(join(ompTestRoot, 'dist/server/client-state.js')).href);
const root = mkdtempSync(join(tmpdir(), 'omp-tasks-')), agent = join(root, 'omp/agent');
mkdirSync(agent, { recursive: true }); writeFileSync(join(root, 'task-evidence.txt'), 'NATIVE_CHILD_READ_EVIDENCE');
const events = [], requests = [], histories = [], readers = []; let client, nestedMode = false;
const held = new Set();
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
	if (child === 'hold') {
		if (!toolsDone) { tool(0, payload.tools.find(item => item.name === 'read' || item.name === '_read').name, { path: join(root, 'task-evidence.txt') }); toolUse = true; }
		else { held.add(res); res.once('close', () => held.delete(res)); return; }
	} else if (child === 'nested-parent' && !toolsDone && taskTool) {
		const item = { name: 'grandchild', task: 'HOLD_NATIVE_CHILD: read task-evidence.txt and wait.', solutionSpace: 'Read only; no edits or further delegation.' };
		tool(0, taskTool.name, taskTool.input_schema.properties?.tasks ? { context: 'Nested fixture.', tasks: [item] } : item); toolUse = true;
	} else if (child === 'nested-parent' && toolsDone) {
		held.add(res); res.once('close', () => held.delete(res)); return;
	} else if (!child && !toolsDone && first.includes('START_NATIVE_TASKS') && taskTool) {
		const tasks = [
			{ name: 'hold-child', task: nestedMode ? 'NEST_PARENT_CHILD: delegate a read to a nested child.' : 'HOLD_NATIVE_CHILD: read task-evidence.txt and wait.', solutionSpace: 'Read only; no edits.' },
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
	client = new OmpClientSession('tasks', root, new ClientStateStore(join(root, 'client-state.json'))); client.attachSink(event => events.push(event), false);
	await client.initialize(); await client.setModel('fixture/fixture');
	const first = client.conversationId, session = client.session;
	await client.prompt('START_NATIVE_TASKS');
	await wait(() => held.size === 1 && session.taskSnapshot().some(task => task.status === 'completed'), 'one held child and completed sibling');
	const tasks = session.taskSnapshot(); assert.equal(tasks.length, 2);
	const heldTask = tasks.find(task => task.status === 'running'), doneTask = tasks.find(task => task.status === 'completed');
	assert(heldTask?.canStop); assert.equal(doneTask.canStop, false);
	const detail = await session.taskRequest(heldTask.id, 'detail');
	assert(detail.messages.some(message => message.content.some(block => block.text?.includes('NATIVE_CHILD_READ_EVIDENCE'))));
	const result = await session.taskRequest(doneTask.id, 'detail');
	assert(result.messages.some(message => message.content.some(block => block.text === 'CHILD_RESULT_COMPLETE')));
	assert(!JSON.stringify(result).includes('SECRET_NATIVE_TASK')); assert(!JSON.stringify(result).includes('sessionFile'));
	await client.newChat(); const second = client.conversationId;
	await assert.rejects(client.session.taskRequest(heldTask.id, 'stop'));
	const generation = session.generation;
	await client.handle({ type: 'omp_task_request', requestId: 'stop-background-child', conversationId: first, taskId: heldTask.id, action: 'stop' });
	assert(events.some(event => event.type === 'omp_task_response' && event.requestId === 'stop-background-child' && event.cancelled));
	await wait(() => held.size === 0 && !session.state.running, 'child cancelled and parent settled');
	assert.equal(session.generation, generation, 'independent cancellation keeps parent worker alive');
	assert.equal(client.conversationId, second, 'background stop does not switch foreground');
	assert.equal(session.taskSnapshot().find(task => task.id === heldTask.id).status, 'aborted');
	assert.equal(session.taskSnapshot().find(task => task.id === doneTask.id).status, 'completed');
	await client.switchConversation(first);
	const beforeRestart = requests.length;
	await session.stop(); await session.open();
	assert.equal(requests.length, beforeRestart, 'worker restart for history never calls the model');
	const restored = session.taskSnapshot(); assert.equal(restored.length, 2);
	assert(restored.every(task => !task.canStop));
	const restoredDone = restored.find(task => task.status === 'completed'); assert(restoredDone);
	assert(restored.some(task => task.status === 'aborted'), 'native aborted tail survives restart');
	assert((await session.taskRequest(restoredDone.id, 'detail')).messages.some(message => message.content.some(block => block.text === 'CHILD_RESULT_COMPLETE')));
	assert.equal((await session.taskRequest(restoredDone.id, 'stop')).cancelled, false);
	await assert.rejects(session.taskRequest(doneTask.id, 'detail'), 'old generation handle remains invalid');
	const original = session.state.messages.find(message => message.role === 'user'); assert(original.entryId);
	await client.handle({ type: 'tree_navigate', conversationId: first, reqId: 'before-delegation', targetId: original.entryId, summary: 'none' });
	assert.equal(session.taskSnapshot().length, 0, 'abandoned branch task roster is hidden');
	await assert.rejects(session.taskRequest(heldTask.id, 'detail'));
	await assert.rejects(session.taskRequest(restoredDone.id, 'detail'), 'restored history respects current branch');
	await client.prompt('START_NATIVE_TASKS');
	await wait(() => held.size === 1, 'second live task before parent Stop');
	const activeTask = session.taskSnapshot().find(task => task.canStop); assert(activeTask);
	await client.abort(); await wait(() => held.size === 0, 'parent Stop closes child stream');
	assert(session.taskSnapshot().every(task => !task.canStop && task.status !== 'running' && task.status !== 'pending'));
	const stoppedCount = requests.length;
	await assert.rejects(session.taskRequest(activeTask.id, 'stop'));
	await assert.rejects(session.taskRequest(activeTask.id, 'detail'));
	assert.equal(requests.length, stoppedCount, 'stale task actions never reopen the worker or resubmit');
	nestedMode = true;
	for (const target of ['parent', 'nested']) {
		await client.newChat(); await client.setModel('fixture/fixture');
		const nestedSession = client.session;
		await client.prompt('START_NATIVE_TASKS');
		await wait(() => held.size === 2 && nestedSession.taskSnapshot().length === 3, 'nested native task visibility');
		const parentTask = nestedSession.taskSnapshot().find(task => task.task?.includes('NEST_PARENT_CHILD')); assert(parentTask);
		if (target === 'nested') {
			const grandchild = nestedSession.taskSnapshot().find(task => task.canStop && task.id !== parentTask.id); assert(grandchild);
			assert.equal((await nestedSession.taskRequest(grandchild.id, 'stop')).cancelled, true);
			await wait(() => held.size === 1, 'independent nested stop');
			assert.equal(nestedSession.taskSnapshot().find(task => task.id === parentTask.id).status, 'running');
		}
		assert.equal((await nestedSession.taskRequest(parentTask.id, 'stop')).cancelled, true);
		await wait(() => held.size === 0 && !nestedSession.state.running, 'nested child cleanup');
		assert(nestedSession.taskSnapshot().every(task => !task.canStop));
		histories.push(nestedSession.state.sessionFile);
	}
	await client.dispose(); client = undefined;
	const afterShutdown = requests.length;
	for (const [index, sessionFile] of histories.entries()) {
		const artifacts = sessionFile.slice(0, -6);
		const childFiles = readdirSync(artifacts, { recursive: true }).filter(name => String(name).endsWith('.jsonl')).map(name => join(artifacts, String(name)));
		const hashes = childFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
		const reader = new OmpSession({ conversationId: `history-${index}`, dataDir: root, cwd: root, sessionFile, onChange() {} }); readers.push(reader);
		await reader.open();
		const restored = reader.taskSnapshot(); assert.equal(restored.length, 3, 'fresh host object restores nested task directory');
		assert(restored.every(task => !task.canStop));
		const grandchild = restored.find(task => task.task?.includes('HOLD_NATIVE_CHILD')); assert(grandchild);
		const detail = await reader.taskRequest(grandchild.id, 'detail');
		assert(detail.messages.some(message => message.content.some(block => block.text?.includes('NATIVE_CHILD_READ_EVIDENCE'))));
		assert(!JSON.stringify(detail).includes('sessionFile')); assert(!JSON.stringify(detail).includes('SECRET_NATIVE_TASK'));
		await assert.rejects(reader.taskRequest(grandchild.id, 'detail', Number.MAX_SAFE_INTEGER));
		await assert.rejects(reader.command('harness_task_history', { handle: sessionFile, cursor: 0 }), 'a file path cannot be used as a history handle');
		assert.equal((await reader.taskRequest(grandchild.id, 'stop')).cancelled, false);
		assert.deepEqual(childFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')), hashes, 'history reads never modify native child transcripts');
		if (process.platform !== 'win32') {
			const native = (await reader.command('harness_history')).data.tasks.find(task => task.task?.includes('HOLD_NATIVE_CHILD'));
			const file = childFiles.find(file => file.endsWith(`/${native.nativeId}.jsonl`)); assert(file);
			const backup = `${file}.saved`, foreign = join(root, `foreign-${index}.jsonl`);
			writeFileSync(foreign, readFileSync(file)); renameSync(file, backup); symlinkSync(foreign, file);
			try { await assert.rejects(reader.taskRequest(grandchild.id, 'detail'), 'cached child cannot follow a replacement symlink'); }
			finally { unlinkSync(file); renameSync(backup, file); }
			assert((await reader.taskRequest(grandchild.id, 'detail')).messages.length > 0);
		}
		await reader.close();
	}
	assert.equal(requests.length, afterShutdown, 'reading restored task history never revives agents or calls models');
	console.log('PASS OMP native tasks: delegation/read, cancellation and isolation, worker/host history restore, nested transcripts, no replay or history writes, branch/path ownership');
} finally { await client?.dispose(); await Promise.allSettled(readers.map(reader => reader.close())); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true }); }
