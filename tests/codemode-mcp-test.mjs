/** Historical smoke entry, now OMP-native MCP execution through the real host.
 * Pi Codemode scripting/settings are intentionally retired; tool results,
 * errors, images and user image actions remain supported product behavior. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { mergeSnapshot } from './lib/snapshots.mjs';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-mcp-execution-'))), cwd = join(root, 'workspace'), data = join(root, 'data'), agent = join(data, 'omp/agent');
mkdirSync(cwd); mkdirSync(agent, { recursive: true });
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGOYUHDgPwgzwBgAX7QK/QPmt8EAAAAASUVORK5CYII=';
const tools = [
	{ name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
	{ name: 'fail', description: 'Return a fixture error', inputSchema: { type: 'object', properties: {} } },
	{ name: 'picture', description: 'Return a PNG', inputSchema: { type: 'object', properties: {} } },
];
const mcpCalls = [], modelCalls = [], events = []; let state, harness, socket, browser, expectedTool, providerError;
const mcp = createServer(async (req, res) => {
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	let raw = ''; for await (const part of req) raw += part;
	const rpc = JSON.parse(raw); mcpCalls.push({ ...rpc, authorization: req.headers.authorization });
	if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
	const result = rpc.method === 'initialize' ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
		: rpc.method === 'tools/list' ? { tools }
		: rpc.method === 'tools/call' ? rpc.params.name === 'add' ? { content: [{ type: 'text', text: `SUM_RESULT_${rpc.params.arguments.a + rpc.params.arguments.b}` }] }
			: rpc.params.name === 'fail' ? { isError: true, content: [{ type: 'text', text: 'MCP_EXPECTED_FAILURE' }] }
			: { content: [{ type: 'text', text: 'MCP_IMAGE_RESULT' }, { type: 'image', mimeType: 'image/png', data: image }] } : {};
	res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
});
const model = createServer(async (req, res) => {
	let raw = ''; for await (const part of req) raw += part;
	const payload = JSON.parse(raw); modelCalls.push(payload);
	const tool = expectedTool; expectedTool = undefined;
	const policy = typeof payload.system === 'string' ? payload.system : payload.system?.map(p => p.text ?? '').join('\n') ?? '';
	const route = tool ? new RegExp('"' + tool + '" → `([^`]+)`').exec(policy)?.[1] : undefined;
	const actualName = route ? payload.tools?.find(t => t.name === '_write' || t.name === 'write')?.name : undefined;
	if (tool && !actualName) providerError = `MCP ${tool} native route unavailable: ${policy.split('\n').filter(line => line.includes('fixture_')).join('\n')}`;
	const input = route ? JSON.stringify({ path: route, content: JSON.stringify(tool === 'add' ? { a: 2, b: 3 } : {}) }) : '';
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
	emit('message_start', { message: { id: `m-${modelCalls.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
	emit('content_block_start', { index: 0, content_block: actualName ? { type: 'tool_use', id: `call-${tool}`, name: actualName, input: {} } : { type: 'text', text: '' } });
	for (const text of actualName ? [input.slice(0, 12), input.slice(12)] : [`DONE_${modelCalls.length}`]) emit('content_block_delta', { index: 0, delta: actualName ? { type: 'input_json_delta', partial_json: text } : { type: 'text_delta', text } });
	emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: actualName ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }); emit('message_stop', {}); res.end();
});
const clientId = 'omp-mcp-execution', token = 'isolated-mcp-token';
const send = value => socket.send(JSON.stringify(value));
const wait = async (fn, label) => { for (let i = 0; i < 1000; i++) { if (providerError) throw Error(providerError); if (await fn()) return; await sleep(25); } throw Error(`Timed out ${label}; ${JSON.stringify(events.slice(-3))}\n${harness?.logs}`); };
const post = async (action, args = {}, headers = {}) => {
	const response = await fetch(`http://127.0.0.1:${harness.port}/api/omp-mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ clientId, cwd, conversationId: state.conversationId, scope: 'global', action, ...args }) });
	return { status: response.status, ...await response.json() };
};
try {
	const mcpPort = await listenIsolated(mcp), modelPort = await listenIsolated(model);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: 'MODEL_FIXTURE_SECRET', models: [{ id: 'fixture', input: ['text', 'image'], contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_WEB_TOKEN: token } });
	socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws?token=${token}`);
	socket.on('message', raw => { const event = JSON.parse(raw); events.push(event); state = mergeSnapshot(state, event); });
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
	send({ type: 'hello', clientId }); await wait(() => events.some(e => e.type === 'ready'), 'ready');
	let view = await post('get'); assert.equal(view.status, 200);
	assert.equal((await post('get', { conversationId: 'foreign' })).status, 409);
	const doc = { mcpServers: { fixture: { type: 'http', url: `http://127.0.0.1:${mcpPort}/mcp`, headers: { Authorization: 'Bearer MCP_FIXTURE_SECRET' } } } };
	view = await post('save', { version: view.config.version, document: doc }); assert.equal(view.status, 200); assert(view.reloadRequired);
	assert.equal(mcpCalls.length, 0, 'save alone does not connect');
	assert(!JSON.stringify(view).includes('MCP_FIXTURE_SECRET'));
	assert.equal((await post('reload')).status, 200);
	await wait(async () => (await post('status')).servers.some(s => s.name === 'fixture' && s.tools.includes('picture')), 'native discovery');
	assert(!state.tools.includes('codemode'), 'retired Pi Codemode is not registered');
	const configBefore = readFileSync(join(agent, 'config.yml'), 'utf8'), mcpBefore = readFileSync(join(agent, 'mcp.json'), 'utf8');
	send({ type: 'native_mcp_request', requestId: 'retired', cwd, scope: 'global', action: 'codemode', codemode: { mode: 'only', inlineBudget: 1 } });
	await wait(() => events.some(e => e.type === 'notice' && e.level === 'error' && e.text.includes('native_mcp_request')), 'retired operation rejected');
	assert.equal(readFileSync(join(agent, 'config.yml'), 'utf8'), configBefore); assert.equal(readFileSync(join(agent, 'mcp.json'), 'utf8'), mcpBefore);
	for (const name of ['add', 'fail', 'picture']) {
		const before = modelCalls.length; expectedTool = name;
		send({ type: 'prompt', text: `Call native MCP ${name}`, requestId: name, target: { cwd, conversationId: state.conversationId, sessionId: state.sessionId } });
		await wait(() => modelCalls.length === before + 2 && !state.isStreaming && state.messages.some(m => m.toolCallId === `call-${name}`), `${name} native tool and final answer`);
		const result = state.messages.find(m => m.toolCallId === `call-${name}`);
		assert.equal(result.isError, name === 'fail', JSON.stringify(result));
		const text = JSON.stringify(modelCalls.at(-1).messages);
		assert(text.includes(name === 'add' ? 'SUM_RESULT_5' : name === 'fail' ? 'MCP_EXPECTED_FAILURE' : 'MCP_IMAGE_RESULT'), 'actual tool result reaches subsequent model request');
		if (name === 'picture') assert(result.content.some(p => p.type === 'image' && p.dataUrl === `data:image/png;base64,${image}`));
	}
	assert.deepEqual(mcpCalls.filter(c => c.method === 'tools/call').map(c => c.params.name), ['add', 'fail', 'picture']);
	assert(mcpCalls.filter(c => c.method === 'tools/call').every(c => c.authorization === 'Bearer MCP_FIXTURE_SECRET'));
	assert(!JSON.stringify(events).includes('MCP_FIXTURE_SECRET')); assert(!JSON.stringify(events).includes('MODEL_FIXTURE_SECRET'));
	const imageRequest = (args = {}, headers = {}) => fetch(`http://127.0.0.1:${harness.port}/api/tool-image`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ clientId, cwd, conversationId: state.conversationId, dataUrl: `data:image/png;base64,${image}`, ...args }) });
	const beforeImages = readdirSync(cwd);
	assert.equal((await imageRequest({}, { Origin: 'https://evil.invalid' })).status, 403);
	assert.equal((await imageRequest({}, { Authorization: 'Bearer wrong' })).status, 401);
	assert.equal((await imageRequest({ cwd: root })).status, 409);
	assert.equal((await imageRequest({ conversationId: 'foreign' })).status, 409);
	assert.equal((await imageRequest({ conversationId: undefined })).status, 409);
	assert.equal((await imageRequest({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
	assert.equal((await imageRequest({ dataUrl: 'data:image/png;base64,YmFk' })).status, 400);
	assert.deepEqual(readdirSync(cwd), beforeImages, 'rejected saves create no files');
	const savedPaths = [];
	for (let i = 0; i < 2; i++) {
		const response = await imageRequest(); assert.equal(response.status, 200);
		const saved = await response.json(); savedPaths.push(saved.path);
		assert.equal(readFileSync(join(cwd, saved.path)).toString('base64'), image);
	}
	assert.notEqual(savedPaths[0], savedPaths[1], 'each user save creates a new file');
	assert.equal(modelCalls.length, 6, 'HTTP image saves never call the model');
	if (process.argv.includes('--browser')) {
		browser = await chromium.launch({ executablePath: CHROME_PATH }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
		const errors = []; page.on('pageerror', error => errors.push(error.message));
		await page.addInitScript(id => sessionStorage.setItem('pi-web-client-id', id), clientId);
		await page.goto(`http://127.0.0.1:${harness.port}/?token=${token}`);
		const card = page.locator('[data-tool-call-id="call-picture"]'); await card.waitFor();
		if (!(await card.locator('.tool-result-image').count())) await card.locator('button[aria-expanded]').first().click();
		await card.locator('.tool-result-image img').waitFor();
		const savedResponse = page.waitForResponse(r => r.url().includes('/api/tool-image'));
		await card.getByRole('button', { name: '保存到当前目录', exact: true }).click();
		const saved = await (await savedResponse).json(); assert.equal(readFileSync(join(cwd, saved.path)).toString('base64'), image);
		await card.getByRole('status').filter({ hasText: '已保存' }).waitFor();
		await card.getByRole('button', { name: '附加到下一条消息', exact: true }).click();
		await page.locator('.attach-chip').filter({ hasText: 'generated-0.png' }).waitFor();
		assert.equal(modelCalls.length, 6, 'user image actions never invoke the model');
		assert(await card.evaluate(el => el.classList.contains('toolcall-generic') && !el.classList.contains('change-card')), 'virtual write uses a tool result, not a file diff');
		mkdirSync('tests/scratch', { recursive: true }); await page.screenshot({ path: 'tests/scratch/omp-mcp-image.png' });
		await page.setViewportSize({ width: 390, height: 844 }); await card.scrollIntoViewIfNeeded();
		assert(await card.locator('.tool-image-preview').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
		await page.screenshot({ path: 'tests/scratch/omp-mcp-image-narrow.png' });
		// Delay a real save until another conversation becomes current. The old
		// card's request must be rejected even when both chats share the same cwd.
		const owner = state.conversationId, fileCount = readdirSync(cwd).length;
		let intercepted, continueSave;
		await page.route('**/api/tool-image**', async route => { intercepted = true; await new Promise(resolve => { continueSave = resolve; }); await route.continue(); });
		await card.getByRole('button', { name: '保存到当前目录', exact: true }).click();
		await wait(() => intercepted, 'delayed image save');
		send({ type: 'new_chat' }); await wait(() => state.conversationId !== owner, 'other conversation');
		const rejectedSave = page.waitForResponse(r => r.url().includes('/api/tool-image'));
		continueSave(); assert.equal((await rejectedSave).status(), 409);
		assert.equal(readdirSync(cwd).length, fileCount);
		await page.locator('.attach-chip').waitFor({ state: 'hidden' });
		send({ type: 'switch_conversation', id: owner }); await wait(() => state.conversationId === owner, 'original conversation');
		await page.locator('.attach-chip').filter({ hasText: 'generated-0.png' }).waitFor();
		assert.equal(modelCalls.length, 6);
		assert.deepEqual(errors, []);
	}
	const sessionFile = state.sessionFile;
	send({ type: 'abort' });
	const promptState = async () => (await (await fetch(`http://127.0.0.1:${harness.port}/api/system-prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ clientId, cwd, conversationId: state.conversationId, action: 'get' }) })).json());
	await wait(async () => !(await promptState()).available, 'stopped worker');
	const barrier = crypto.randomUUID(); send({ type: 'tree_get', reqId: barrier, conversationId: state.conversationId, filter: 'all' });
	await wait(() => events.some(e => e.type === 'tree' && e.reqId === barrier), 'Stop completed');
	const history = readFileSync(sessionFile, 'utf8');
	assert.equal((await imageRequest()).status, 200, 'user image save works without a running agent');
	assert.equal((await promptState()).available, false, 'saving must not revive the stopped worker');
	assert.equal(readFileSync(sessionFile, 'utf8'), history, 'user image save does not alter native history');
	assert.equal(modelCalls.length, 6);
	console.log('PASS OMP MCP execution: native routes and split arguments, success/error/image feedback, image save/attach ownership, Stop isolation and retired Codemode controls');
} finally { await browser?.close(); socket?.terminate(); await harness?.stop(); for (const server of [mcp, model]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } rmSync(root, { recursive: true, force: true }); }
