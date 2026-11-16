/** Known failing diagnostic: native Task must stop writing externally edited history.
 * Run explicitly; not a passing acceptance test and not included in smoke.
 * Uses isolated files and a local model fixture, never real project contents. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOmpTestModule, ompTestRoot } from '../lib/omp-runtime-location.mjs';
import { listenIsolated } from '../lib/isolated-server.mjs';
import { scrubHostEnv } from '../lib/test-env.mjs';
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

	const artifacts = session.state.sessionFile.slice(0, -6);
	const childFiles = readdirSync(artifacts, { recursive: true }).filter(name => String(name).endsWith('.jsonl')).map(name => join(artifacts, String(name)));
	const childFile = childFiles.find(file => readFileSync(file, 'utf8').includes('NATIVE_CHILD_READ_EVIDENCE'));
	assert(childFile, 'held child transcript must exist');
	const before = readFileSync(childFile, 'utf8');
	const edited = before.replace('NATIVE_CHILD_READ_EVIDENCE', 'EXTERNAL_CHILD_EDIT_PROBE!');
	assert.equal(Buffer.byteLength(edited), Buffer.byteLength(before));
	writeFileSync(childFile, edited);
	for (const response of [...held]) {
		const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
		emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PROBE_CHILD_FINISHED' } });
		emit('content_block_stop', { index: 0 });
		emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } });
		emit('message_stop', {}); response.end();
	}
	await wait(() => !session.state.running && session.taskSnapshot().every(task => !task.canStop), 'child settled after external edit');
	const after = readFileSync(childFile, 'utf8');
	const result = { fileChangedAfterExternalEdit: after !== edited, externalEditRetained: after.includes('EXTERNAL_CHILD_EDIT_PROBE!'), laterOutputAppended: after.includes('PROBE_CHILD_FINISHED'), parentPersistenceFailed: session.state.persistence?.failed === true, taskStatuses: session.taskSnapshot().map(task => task.status) };
	console.log(JSON.stringify(result));
	assert.equal(result.fileChangedAfterExternalEdit, false, 'Task must not keep writing an externally edited transcript');
} finally { await client?.dispose(); await Promise.allSettled(readers.map(reader => reader.close())); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true }); }
