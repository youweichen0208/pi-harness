/** Actual native child spills: scoped downloads, nesting, Stop, history and browser. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOmpTestModule, ompTestRoot, ompTestExecutable, ompTestPackaged } from './lib/omp-runtime-location.mjs';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { scrubHostEnv } from './lib/test-env.mjs';
import WebSocket from 'ws';
import { mergeSnapshot } from './lib/snapshots.mjs';
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete process.env[key];
const { OmpClientSession } = await loadOmpTestModule('chat-service.js');
const { ClientStateStore } = await import(pathToFileURL(join(ompTestRoot, 'dist/server/client-state.js')).href);
const root = mkdtempSync(join(tmpdir(), 'omp-tasks-')), agent = join(root, 'omp/agent');
mkdirSync(agent, { recursive: true }); writeFileSync(join(root, 'task-evidence.txt'), 'NATIVE_CHILD_READ_EVIDENCE\n' + 'child output 中文\n'.repeat(40000) + 'CHILD_OUTPUT_END\n');
const events = [], requests = []; let client, harness, socket, browser, lastHistory, nestedMode = false;
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
		event('content_block_start', { index, content_block: { type: 'tool_use', id: ['bash', '_bash'].includes(name) ? 'shared-child-call' : `${name}-${requests.length}-${index}`, name, input: {} } });
		event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
		event('content_block_stop', { index });
	};
	const toolsDone = payload.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
	const taskTool = payload.tools?.find(item => item.name === 'task' || item.name === '_task');
	let toolUse = false;
	if (child === 'hold') {
		if (!toolsDone) { tool(0, payload.tools.find(item => item.name === 'bash' || item.name === '_bash').name, { command: 'cat task-evidence.txt' }); toolUse = true; }
		else { held.add(res); res.once('close', () => held.delete(res)); return; }
	} else if (child === 'finish' && !toolsDone) {
		tool(0, payload.tools.find(item => item.name === 'bash' || item.name === '_bash').name, { command: 'printf SIBLING_SHORT_OUTPUT' }); toolUse = true;
	} else if (child === 'nested-parent' && !toolsDone && taskTool) {
		const item = { name: 'grandchild', task: 'HOLD_NATIVE_CHILD: read task-evidence.txt and wait.', solutionSpace: 'Read only; no edits or further delegation.' };
		tool(0, taskTool.name, taskTool.input_schema.properties?.tasks ? { context: 'Nested fixture.', tasks: [item] } : item); toolUse = true;
	} else if (child === 'nested-parent' && toolsDone) {
		held.add(res); res.once('close', () => held.delete(res)); return;
	} else if (!child && !toolsDone && first.includes('START_NATIVE_TASKS') && taskTool) {
		const tasks = [
			{ name: 'hold-child', task: nestedMode ? 'NEST_PARENT_CHILD: delegate a read to a nested child.' : 'HOLD_NATIVE_CHILD: read task-evidence.txt and wait.', solutionSpace: 'Read only; no edits.' },
			{ name: 'finish-child', task: 'FINISH_NATIVE_CHILD: run printf SIBLING_SHORT_OUTPUT, then finish.', solutionSpace: 'Print the fixture marker only.' },
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
	const bytes = async output => { const chunks = []; for await (const chunk of output.handle.createReadStream()) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
	const expected = readFileSync(join(root, 'task-evidence.txt'));
	const digest = data => createHash('sha256').update(data).digest('hex');
	for (nestedMode of [false, true]) {
		if (nestedMode) { await client.newChat(); await client.setModel('fixture/fixture'); }
		const conversation = client.conversationId, session = client.session;
		await client.prompt('START_NATIVE_TASKS');
		await wait(() => held.size === (nestedMode ? 2 : 1) && session.taskSnapshot().some(task => task.status === 'completed'), 'child spill and completed sibling');
		const tasks = session.taskSnapshot(); assert.equal(tasks.length, nestedMode ? 3 : 2);
		const target = tasks.find(task => task.task?.includes('HOLD_NATIVE_CHILD'));
		const sibling = tasks.find(task => task.status === 'completed'); assert(target && sibling);
		await client.handle({ type: 'omp_task_request', requestId: 'child-output', conversationId: conversation, taskId: target.id, action: 'detail' });
		const detail = events.findLast(event => event.type === 'omp_task_response' && event.requestId === 'child-output');
		assert(detail && !detail.error);
		const displayed = detail.messages.find(message => message.role === 'toolResult' && message.content.some(block => block.text?.includes('NATIVE_CHILD_READ_EVIDENCE')));
		assert(displayed); assert(detail.truncated); assert.equal(displayed.toolCallId, 'shared-child-call');
		assert.equal(new URL(displayed.toolOutputUrl, 'http://fixture').searchParams.get('taskId'), target.id);
		assert(!JSON.stringify(detail).includes('SECRET_NATIVE_TASK'));
		const output = await client.downloadToolOutput(conversation, displayed.toolCallId, undefined, target.id);
		assert.match(output.name, /\.log$/); assert.equal(digest(await bytes(output)), digest(expected));
		const files = await client.listToolOutputs(conversation, displayed.toolCallId, target.id);
		assert(files.some(file => file.default && !file.partial));
		assert((await bytes(await client.downloadToolOutput(conversation, 'shared-child-call', undefined, sibling.id))).toString().includes('SIBLING_SHORT_OUTPUT'), 'same tool call ID in a sibling must resolve its own text');
		await assert.rejects(client.downloadToolOutput(conversation, displayed.toolCallId), error => error.code === 'EACCES');
		await assert.rejects(client.downloadToolOutput('foreign', displayed.toolCallId, undefined, target.id), error => error.code === 'EACCES');
		await assert.rejects(client.downloadToolOutput(conversation, displayed.toolCallId, undefined, '../foreign'), error => error.code === 'EACCES');
		await assert.rejects(client.downloadToolOutput(conversation, displayed.toolCallId, '../foreign', target.id), error => error.code === 'EACCES');
		await session.stop(); await wait(() => held.size === 0, 'Stop closes all child streams');
		const calls = requests.length, file = session.state.sessionFile, before = digest(readFileSync(file));
		assert.equal(digest(await bytes(await client.downloadToolOutput(conversation, displayed.toolCallId, undefined, target.id))), digest(expected));
		assert.equal(session.generation, undefined, 'downloads never revive a stopped worker');
		assert.equal(digest(readFileSync(file)), before, 'download never rewrites parent history');
		const artifactRoot = file.slice(0, -6), artifact = join(artifactRoot, output.name), backup = join(root, 'saved-child-output.log');
		renameSync(artifact, backup);
		try { await assert.rejects(client.downloadToolOutput(conversation, displayed.toolCallId, undefined, target.id), error => error.code === 'ENOENT'); }
		finally { renameSync(backup, artifact); }
		if (process.platform !== 'win32') {
			renameSync(artifact, backup); symlinkSync(join(root, 'task-evidence.txt'), artifact);
			try { await assert.rejects(client.downloadToolOutput(conversation, displayed.toolCallId, undefined, target.id), error => error.code === 'EACCES'); }
			finally { unlinkSync(artifact); renameSync(backup, artifact); }
		}
		if (process.platform !== 'win32') {
			const transcript = session.taskOutputPath(target.id).reduce((parent, step) => join(parent.slice(0, -6), `${step.nativeId}.jsonl`), file);
			const saved = join(root, 'saved-child-transcript.jsonl');
			renameSync(transcript, saved); symlinkSync(saved, transcript);
			try { await assert.rejects(client.downloadToolOutput(conversation, displayed.toolCallId, undefined, target.id), error => error.code === 'EACCES'); }
			finally { unlinkSync(transcript); renameSync(saved, transcript); }
		}
		await session.open();
		const restored = session.taskSnapshot().find(task => task.task?.includes('HOLD_NATIVE_CHILD')); assert(restored);
		assert.equal(digest(await bytes(await client.downloadToolOutput(conversation, displayed.toolCallId, undefined, restored.id))), digest(expected));
		await assert.rejects(client.downloadToolOutput(conversation, displayed.toolCallId, undefined, target.id), error => error.code === 'EACCES');
		const user = session.state.messages.find(message => message.role === 'user'), tip = session.state.tree.leafId;
		await client.handle({ type: 'tree_navigate', conversationId: conversation, reqId: 'hide-child', targetId: user.entryId, summary: 'none' });
		assert.equal(session.taskSnapshot().length, 0);
		await assert.rejects(client.downloadToolOutput(conversation, displayed.toolCallId, undefined, restored.id), error => error.code === 'EACCES');
		await client.handle({ type: 'tree_navigate', conversationId: conversation, reqId: 'restore-child', targetId: tip, summary: 'none' });
		assert.equal(events.findLast(event => event.reqId === 'restore-child')?.status, 'ok');
		assert.equal(requests.length, calls, 'reads, Stop/reopen and non-summarizing navigation never call the model');
		lastHistory = file;
	}
	await client.dispose(); client = undefined;
	const calls = requests.length;
	harness = await startIsolatedHarness({ executable: ompTestExecutable, args: [join(ompTestRoot, 'dist/server/index.js')], env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: root, PI_WEB_TOKEN: 'fixture-token', ...(ompTestPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
	socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws?token=fixture-token`);
	let state, ready = false;
	socket.on('message', raw => { const message = JSON.parse(raw); state = mergeSnapshot(state, message); if (message.type === 'ready') ready = true; });
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
	socket.send(JSON.stringify({ type: 'hello', clientId: 'http-child-output' }));
	await wait(() => ready && state?.ompTasks?.some(task => task.task?.includes('HOLD_NATIVE_CHILD')), 'HTTP restored child roster');
	socket.send(JSON.stringify({ type: 'switch_session', path: lastHistory }));
	await wait(() => state.sessionFile === lastHistory && state.ompTasks?.length === 3, 'explicit nested history selection');
	const target = state.ompTasks.find(task => task.task?.includes('HOLD_NATIVE_CHILD'));
	const url = `http://127.0.0.1:${harness.port}/api/tool-output?${new URLSearchParams({ clientId: 'http-child-output', conversationId: state.conversationId, taskId: target.id, toolCallId: 'shared-child-call' })}`;
	assert.equal((await fetch(url)).status, 401);
	assert.equal((await fetch(url + '&token=fixture-token', { headers: { Origin: 'https://foreign.example' } })).status, 403);
	assert.equal((await fetch(url.replace(target.id, 'foreign-task') + '&token=fixture-token')).status, 403);
	assert.equal((await fetch(url + '&token=fixture-token&taskId=duplicate')).status, 400);
	const response = await fetch(url + '&token=fixture-token'); assert.equal(response.status, 200);
	assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(expected));
	assert(response.headers.get('content-disposition').includes('attachment'));
	if (process.env.HARNESS_TEST_BROWSER === '1') {
		const { chromium } = await import('playwright-core'), { CHROME_PATH } = await import('./lib/chrome.mjs');
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
		const errors = []; page.on('pageerror', error => errors.push(error.message));
		await page.addInitScript(() => sessionStorage.setItem('pi-web-client-id', 'http-child-output'));
		await page.goto(`http://127.0.0.1:${harness.port}/?token=fixture-token`);
		await page.getByRole('tab', { name: '任务', exact: true }).click();
		await page.locator('.panel-lower .omp-task-list button').nth(state.ompTasks.indexOf(target)).click();
		const dialog = page.getByRole('dialog', { name: target.title, exact: true }); await dialog.waitFor();
		await dialog.getByRole('button', { name: '执行过程', exact: true }).click();
		await dialog.getByText(/NATIVE_CHILD_READ_EVIDENCE/).first().waitFor();
		const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /下载输出|Download output/ }).click()]);
		assert.equal(digest(readFileSync(await download.path())), digest(expected));
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await dialog.evaluate(element => element.getBoundingClientRect().width <= innerWidth));
		const downloadButton = dialog.getByRole('button', { name: /下载输出|Download output/ });
		await downloadButton.scrollIntoViewIfNeeded();
		assert(await downloadButton.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }));
		mkdirSync('tests/scratch', { recursive: true }); await page.screenshot({ path: 'tests/scratch/omp-task-output.png' });
		assert.deepEqual(errors, []);
		console.log('PASS browser native nested task output: actual saved bytes, scoped link and narrow drawer');
	}
	assert.equal(requests.length, calls, 'server/browser reads never replay any task');
	console.log('PASS native Task output: real shared-root spill, sibling duplicate IDs, nested ancestry, Stop, restore, branch ownership, missing/symlink files and authenticated HTTP');
} finally { await browser?.close(); socket?.close(); await harness?.stop(); await client?.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true }); }
