/** Native request hooks, actual provider bodies and main/Task diagnostic isolation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, homedir } from 'node:os';
import { loadOmpTestModule, ompTestRoot } from './lib/omp-runtime-location.mjs';
import { listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
const { OmpSession } = await loadOmpTestModule('session.js');
const { OmpTransport } = await loadOmpTestModule('transport.js');
const fixtureEnv = overrides => {
	const env = testEnv(overrides);
	for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|PROXY|^ANTHROPIC_|^OPENAI_/i.test(key)) delete env[key];
	return env;
};
const root = mkdtempSync(join(tmpdir(), 'omp-request-diagnostics-')), agent = join(root, 'omp/agent'), logs = join(root, 'diagnostics');
mkdirSync(agent, { recursive: true });
const secret = 'UNLABELLED_PROJECT_AND_CREDENTIAL_736', file = join(root, 'evidence.txt');
writeFileSync(file, secret);
const sessions = [], bodies = [], children = [], sockets = new Set();
const fixture = createServer(async (req, res) => {
	if (req.method !== 'POST' || !/\/(messages|chat\/completions)$/.test(new URL(req.url, 'http://127.0.0.1').pathname)) { res.writeHead(404); res.end(); return; }
	let raw = ''; for await (const chunk of req) raw += chunk;
	const body = JSON.parse(raw); bodies.push(body);
	const first = JSON.stringify(body.messages.find(message => message.role === 'user')?.content), openai = req.url.includes('chat/completions');
	const toolDone = body.messages.some(message => message.role === 'tool' || Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
	res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': secret, 'set-cookie': secret });
	sockets.add(res); res.on('close', () => sockets.delete(res));
	const toolName = name => body.tools.find(tool => (tool.name ?? tool.function?.name) === name || (tool.name ?? tool.function?.name) === `_${name}`);
	if (openai) {
		const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'private-completion', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		if (!toolDone) {
			emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'private-call', type: 'function', function: { name: toolName('read').function.name, arguments: JSON.stringify({ path: file }) } }] }); emit({}, 'tool_calls');
		} else { emit({ role: 'assistant', content: secret }); emit({}, 'stop'); }
		res.end('data: [DONE]\n\n'); return;
	}
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: 'private-message', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
	const finish = tool => { emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 12 } }); emit('message_stop', {}); res.end(); };
	const text = () => { emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: secret } }); emit('content_block_stop', { index: 0 }); finish(false); };
	const call = (index, name, args) => { emit('content_block_start', { index, content_block: { type: 'tool_use', id: `private-${index}-${bodies.length}`, name, input: {} } }); const json = JSON.stringify(args); for (const partial_json of [json.slice(0, 8), json.slice(8)]) emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json } }); emit('content_block_stop', { index }); };
	if (first.includes('CHILD_DIAGNOSTIC')) { children.push(text); if (children.length === 9) for (const done of children) done(); return; }
	if (first.includes('SPAWN_DIAGNOSTIC') && !toolDone) {
		const tool = toolName('task'), tasks = Array.from({ length: 9 }, (_, i) => ({ name: `child-${i}`, task: `CHILD_DIAGNOSTIC ${i}: reply directly.`, solutionSpace: 'No tools or edits.' }));
		assert(tool, 'native task tool must be declared');
		if (tool.input_schema.properties.tasks) call(0, tool.name, { context: 'Independent fixture tasks.', tasks });
		else tasks.forEach((task, i) => call(i, tool.name, task));
		finish(true); return;
	}
	if (!toolDone && !first.includes('SPAWN_DIAGNOSTIC')) { call(0, toolName('read').name, { path: file }); finish(true); } else text();
});
const wait = async (predicate, label) => { for (let i = 0; i < 1200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(`Timed out: ${label}`); };
const readLogs = (directory = logs) => readdirSync(directory).filter(name => name.endsWith('.jsonl')).flatMap(name => readFileSync(join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => ({ file: name, ...JSON.parse(line) })));
const completed = session => !session.state.running && session.state.messages.some(message => message.role === 'assistant' && message.content.some(block => block.text === secret));
const open = async (id, provider, diagnostic = true, restricted) => {
	const session = new OmpSession({ conversationId: id, dataDir: root, cwd: root, model: `${provider}/fixture`, env: fixtureEnv(diagnostic ? { PI_WEB_MODEL_DIAGNOSTICS_DIR: typeof diagnostic === 'string' ? diagnostic : logs } : {}), restricted, onChange() {} });
	sessions.push(session); await session.open(); return session;
};
try {
	const port = await listenIsolated(fixture);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: Object.fromEntries(['anthropic', 'openai'].map(provider => [provider, { api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: secret, headers: { 'X-Private': secret }, models: [{ id: 'fixture', contextWindow: 200000, maxTokens: 128000 }] }])) }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false }, async: { enabled: false }, task: { workerThreads: 1, maxConcurrency: 9 } }));
	const a = await open('anthropic', 'anthropic'); await a.prompt(`READ_DIAGNOSTIC ${secret}`);
	await wait(() => completed(a), 'Anthropic completion');
	let records = readLogs(), requests = records.filter(record => record.type === 'before_provider_request');
	assert.equal(requests.length, 2, 'native provider request observations must include both tool rounds: ' + JSON.stringify({ httpRequests: bodies.length, messages: a.state.messages.map(message => ({ role: message.role, stopReason: message.stopReason, error: message.errorMessage?.replaceAll(secret, '<redacted>').replaceAll(root, '<fixture>') })) }));
	assert.equal(requests[0].payload.maxTokens, bodies[0].max_tokens);
	assert.equal(requests[0].payload.toolCount, bodies[0].tools.length);
	const finalHistory = requests[1].payload.messages;
	const call = finalHistory.flatMap(message => message.blocks).find(block => block.type === 'tool_use');
	const result = finalHistory.flatMap(message => message.blocks).find(block => block.type === 'tool_result');
	assert(call && result); assert.equal(call.call, result.call, 'actual native history call/result pairing');
	assert(records.some(record => record.type === 'after_provider_response' && record.status === 200));
	assert(records.some(record => record.file.startsWith('provider-events-') && record.type === 'message_update' && record.streamType === 'toolcall_delta'));
	const hostRuns = new Set(records.filter(record => record.file.startsWith('model-events-')).map(record => record.runId));
	assert(requests.every(record => hostRuns.has(record.runId)), 'provider and host consumer traces share a run ID');
	const o = await open('openai', 'openai'); await o.prompt(`READ_DIAGNOSTIC ${secret}`); await wait(() => completed(o), 'OpenAI completion');
	records = readLogs(); const openaiRequests = records.filter(record => record.type === 'before_provider_request' && record.api === 'openai-completions');
	assert.equal(openaiRequests.length, 2);
	const last = openaiRequests.at(-1).payload.messages;
	assert.equal(last.find(message => message.calls.length).calls[0].call, last.find(message => message.role === 'tool').call);
	const restricted = await open('restricted', 'anthropic', true, { systemPrompt: 'Read the requested file.', toolNames: ['read'] });
	await restricted.prompt('READ_DIAGNOSTIC'); await wait(() => completed(restricted), 'restricted completion');
	assert(readLogs().filter(record => record.type === 'before_provider_request').length >= 6, 'restricted session uses the same observer without ambient extensions');
	const beforeOff = readdirSync(logs).sort();
	const off = await open('off', 'anthropic', false); await off.prompt('READ_DIAGNOSTIC'); await wait(() => completed(off), 'diagnostics off');
	assert.deepEqual(readdirSync(logs).sort(), beforeOff, 'diagnostics off adds no trace or extension');
	const blocked = join(root, 'blocked-diagnostic-directory'); writeFileSync(blocked, 'fixture');
	const failedWriter = await open('bad-log-storage', 'anthropic', join(blocked, 'child'));
	await failedWriter.prompt('READ_DIAGNOSTIC'); await wait(() => completed(failedWriter), 'failed diagnostic storage does not interrupt model');
	const parent = await open('parent', 'anthropic'); await parent.prompt('SPAWN_DIAGNOSTIC');
	await wait(() => children.length === 9 && completed(parent), 'nine native children');
	records = readLogs(); requests = records.filter(record => record.type === 'before_provider_request');
	const childRequests = requests.filter(record => record.agent === 'sub');
	assert.equal(new Set(childRequests.map(record => record.session)).size, 9, 'every native Task child has a separate observed session');
	assert(childRequests.every(record => !record.workerThread), 'native SDK embedding deliberately has no CLI worker host');
	assert.equal(new Set(childRequests.map(record => record.runId)).size, 1);
	assert(!JSON.stringify(records).includes(secret)); assert(!JSON.stringify(records).includes(file));
	assert(!JSON.stringify(records).includes('private-call')); assert(!JSON.stringify(records).includes('CHILD_DIAGNOSTIC'));
	const count = requests.length; await parent.stop(); assert.equal(await parent.requestIfOpen('get_state'), undefined);
	assert.equal(readLogs().filter(record => record.type === 'before_provider_request').length, count, 'Stop cannot create diagnostic provider requests');
	// Exercise worker inheritance through the actual native CLI host. Never call
	// declareWorkerHostEntry from SDK embedding: the native API forbids that.
	children.length = 0;
	const cliLogs = join(root, 'cli-diagnostics'), require = createRequire(join(ompTestRoot, 'package.json'));
	const bun = join(dirname(require.resolve('bun/package.json')), 'bin', 'bun.exe');
	const nativePackage = join(ompTestRoot, 'node_modules/@oh-my-pi/pi-coding-agent');
	const cli = join(nativePackage, JSON.parse(readFileSync(join(nativePackage, 'package.json'), 'utf8')).bin.omp);
	const cliEnv = fixtureEnv({ PI_CONFIG_DIR: relative(homedir(), join(root, 'native-config')), PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(root, 'cli-sessions'), HARNESS_OMP_REQUEST_DIAGNOSTICS_DIR: cliLogs, HARNESS_OMP_DIAGNOSTICS_RUN: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
	const control = process.env.HARNESS_TEST_OMP_CLI_MODE === 'print-control';
	const cliArgs = ['--no-title', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp', '--no-extensions', '--model', 'anthropic/fixture', ...(control ? [] : ['--extension', join(ompTestRoot, 'dist/server/omp/request-diagnostics-extension.js')])];
	if (process.env.HARNESS_TEST_OMP_CLI_MODE?.startsWith('print')) {
		// Separate diagnostic: native JSON/print exit must not be mistaken for RPC acceptance.
		try {
			const execution = promisify(execFile)(bun, [cli, '--mode', 'json', '--print', '--wait-async', ...cliArgs, 'SPAWN_DIAGNOSTIC'], {
				cwd: root, env: cliEnv, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
			});
			execution.child.stdin.end(); // Native print mode waits for piped input EOF.
			await execution;
		} catch (error) {
			const types = String(error.stdout ?? '').split('\n').flatMap(line => { try { const row = JSON.parse(line); return [{ type: row.type, status: row.status, role: row.message?.role }]; } catch { return []; } }).slice(-20);
			console.error(JSON.stringify({ cliChildren: children.length, types, stderr: String(error.stderr ?? '').replaceAll(secret, '<redacted>').replaceAll(root, '<fixture>').slice(-2000) }));
			throw Error(`Native CLI diagnostic fixture failed (${error.code ?? 'unknown'})`);
		}
	} else {
		let result, exit;
		const transport = new OmpTransport({ conversationId: 'native-cli', executable: bun, args: [cli, '--mode', 'rpc', ...cliArgs], cwd: root, env: cliEnv, onEvent() {}, onExit(error) { exit = error; } });
		try {
			await transport.request('get_state');
			await transport.request('prompt', { message: 'SPAWN_DIAGNOSTIC' }, frame => { result = frame; });
			await wait(() => { if (exit) throw exit; return result && children.length === 9; }, 'native CLI RPC completion');
			assert.equal(result.status, 'completed', 'native CLI RPC confirms entire task settlement');
		} finally { await transport.close(); }
	}
	const cliRecords = control ? [] : readLogs(cliLogs), cliChildren = cliRecords.filter(record => record.type === 'before_provider_request' && record.agent === 'sub');
	if (!control) {
		assert.equal(new Set(cliChildren.map(record => record.session)).size, 9);
		assert(cliChildren.some(record => record.workerThread), 'native CLI must exercise a real Task worker thread');
		assert(!JSON.stringify(cliRecords).includes(secret));
	}
	console.log(control ? 'PASS native CLI print control without diagnostic extension' : 'PASS OMP request diagnostics: actual Anthropic/OpenAI bodies, tool pairing, main/restricted/off/failed storage, nine SDK children and native CLI RPC Task threads, host correlation, privacy and Stop');
} finally {
	for (const res of sockets) res.destroy();
	await Promise.allSettled(sessions.map(session => session.close()));
	fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); rmSync(root, { recursive: true, force: true });
}
