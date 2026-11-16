import { mergeSnapshot, snapshotStates } from "./lib/snapshots.mjs";
/** Actual native bash spill, full bytes, ownership, and downloads after Stop. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, renameSync, symlinkSync, unlinkSync, truncateSync, openSync, closeSync, writeSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OmpClientSession } from '../dist/server/omp/chat-service.js';
import { ClientStateStore } from '../dist/server/client-state.js';
import WebSocket from 'ws';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { scrubHostEnv } from './lib/test-env.mjs';
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete process.env[key];
const partial = process.argv.includes('--partial');
const root = mkdtempSync(join(tmpdir(), 'omp-output-')), agent = join(root, 'omp/agent');
mkdirSync(agent, { recursive: true });
const expected = 'OMP_OUTPUT_START\n' + 'native output 中 '.repeat(80) + '\n' + 'row 中文\n'.repeat(40000) + 'OMP_OUTPUT_END\n';
writeFileSync(join(root, 'output.txt'), expected);
let client, harness, socket, browser, requests = 0;
const provider = createServer(async (req, res) => {
	let raw = ''; for await (const chunk of req) raw += chunk;
	const body = JSON.parse(raw); requests++;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `response-${requests}`, role: 'assistant', type: 'message', model: 'fixture', content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
	const result = body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
	const block = result ? { type: 'text', text: '' } : { type: 'tool_use', id: 'native-output', name: body.tools.find(tool => ['bash', '_bash'].includes(tool.name)).name, input: { command: 'cat output.txt' } };
	emit('content_block_start', { index: 0, content_block: block });
	if (result) emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OUTPUT_DONE' } });
	emit('content_block_stop', { index: 0 });
	if (!result) { emit('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'short-output', name: block.name, input: { command: 'printf NATIVE_SHORT_OUTPUT' } } }); emit('content_block_stop', { index: 1 }); }
	emit('message_delta', { delta: { stop_reason: result ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 1 } }); emit('message_stop', {}); res.end();
});
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = async output => { const chunks = []; for await (const chunk of output.handle.createReadStream()) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'FIXTURE_ONLY', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, ...(partial ? { tools: { artifactMaxBytes: 0.125 } } : {}) }));
	client = new OmpClientSession('output-client', root, new ClientStateStore(join(root, 'client-state.json')));
	const events = []; client.attachSink(event => events.push(event), false);
	await client.initialize(); await client.setModel('fixture/fixture'); await client.prompt('Run cat output.txt once.');
	for (let i = 0; i < 1500 && client.session.state.running; i++) await delay(20);
	assert.equal(client.session.state.running, false);
	assert(client.session.messages.some(message => message.role === 'assistant' && message.content.some(block => block.text === 'OUTPUT_DONE')), 'fixture must complete its native turn');
	const result = client.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'native-output');
	assert(result && !result.isError, JSON.stringify(result));
	const conversation = client.conversationId, call = result.toolCallId, file = client.session.state.sessionFile;
	const native = JSON.parse(readFileSync(file, 'utf8').split('\n').find(line => line.includes('"toolResult"') && line.includes('"native-output"')));
	assert(native.message.details.meta.truncation.artifactId, 'must exercise a real native spill');
	const artifactDir = file.slice(0, -6), artifactFile = join(artifactDir, readdirSync(artifactDir).find(name => name.startsWith(`${native.message.details.meta.truncation.artifactId}.`)));
	const captured = readFileSync(artifactFile);
	if (partial) { assert(captured.length < Buffer.byteLength(expected)); assert(native.message.details.meta.truncation.artifactElidedBytes > 0); }
	else assert.equal(hash(captured), hash(expected), 'native artifact contains the full output');
	assert.equal(hash(await bytes(await client.downloadToolOutput(conversation, call))), hash(captured), 'download must return original bytes, not the native transcript preview');
	client.flushSnapshot();
	assert(snapshotStates(events).at(-1).messages.find(message => message.toolCallId === call)?.toolOutputUrl, 'the real tool card receives its download link');
	const outputs = await client.listToolOutputs(conversation, call);
	assert(outputs.some(output => output.default));
	assert.equal(outputs.find(output => output.default).partial, partial);
	assert.equal(outputs.find(output => output.default).name.startsWith('partial-'), partial);
	await assert.rejects(client.downloadToolOutput('another-conversation', call), error => error.code === 'EACCES');
	await assert.rejects(client.downloadToolOutput(conversation, call, '../output.txt'), error => error.code === 'EACCES');
	const tip = client.session.messages.findLast(message => message.role === 'assistant').entryId;
	assert(tip, 'native final reply must have an entry ID');
	const user = client.session.messages.find(message => message.role === 'user');
	await client.handle({ type: 'tree_navigate', conversationId: conversation, reqId: 'hide-output', targetId: user.entryId, summary: 'none' });
	assert(!client.session.messages.some(message => message.toolCallId === call), 'fixture hides the tool from the active branch');
	assert.equal(hash(await bytes(await client.downloadToolOutput(conversation, call))), hash(captured), 'all native entries remain accessible after branch navigation');
	await client.abort();
	assert.equal(client.session.generation, undefined);
	const before = hash(readFileSync(file)), calls = requests;
	assert.equal(hash(await bytes(await client.downloadToolOutput(conversation, call))), hash(captured));
	assert.equal(client.session.generation, undefined, 'downloading after Stop must never restart the agent');
	assert.equal(hash(readFileSync(file)), before, 'metadata download leaves history untouched');
	assert.equal(requests, calls);
	assert((await bytes(await client.downloadToolOutput(conversation, 'short-output'))).toString().includes('NATIVE_SHORT_OUTPUT'), 'short output falls back to native text');
	writeFileSync(join(artifactDir, '999999.bash.log'), 'UNREFERENCED_SECRET');
	await assert.rejects(client.downloadToolOutput(conversation, call, 'artifact-999999'), error => error.code === 'EACCES');
	const saved = join(root, 'saved-native-output.log');
	renameSync(artifactFile, saved);
	await assert.rejects(client.downloadToolOutput(conversation, call), error => error.code === 'ENOENT');
	renameSync(saved, artifactFile);
	if (process.platform !== 'win32') {
		renameSync(artifactFile, saved); symlinkSync(join(root, 'output.txt'), artifactFile);
		try { await assert.rejects(client.listToolOutputs(conversation, call), error => error.code === 'EACCES'); await assert.rejects(client.downloadToolOutput(conversation, call), error => error.code === 'EACCES'); }
		finally { unlinkSync(artifactFile); renameSync(saved, artifactFile); }
	}
	const savedDir = `${artifactDir}.saved`;
	renameSync(artifactDir, savedDir); symlinkSync(savedDir, artifactDir, 'junction');
	try { await assert.rejects(client.listToolOutputs(conversation, call), error => error.code === 'EACCES'); }
	finally { unlinkSync(artifactDir); renameSync(savedDir, artifactDir); }
	const largeBytes = 600 * 1024 * 1024;
	truncateSync(artifactFile, largeBytes);
	const fd = openSync(artifactFile, 'r+'); try { writeSync(fd, Buffer.from('LARGE_OUTPUT_END'), 0, 16, largeBytes - 16); } finally { closeSync(fd); }
	const streamed = async stream => { let size = 0; const digest = createHash('sha256'); for await (const chunk of stream) { size += chunk.length; digest.update(chunk); } return { size, hash: digest.digest('hex') }; };
	const largeExpected = await streamed(createReadStream(artifactFile));
	assert.deepEqual(await streamed((await client.downloadToolOutput(conversation, call)).handle.createReadStream()), largeExpected, '600 MiB artifact streams without fitting into an RPC or text buffer');
	assert.equal(largeExpected.size, largeBytes); writeFileSync(artifactFile, captured);
	assert.equal(client.session.generation, undefined); assert.equal(requests, calls);
	await client.handle({ type: 'session_reopen', conversationId: conversation, reqId: 'reopen-for-navigation' });
	assert.equal(events.findLast(event => event.reqId === 'reopen-for-navigation')?.status, 'ok');
	await client.handle({ type: 'tree_navigate', conversationId: conversation, reqId: 'restore-output', targetId: tip, summary: 'none' });
	assert.equal(events.findLast(event => event.reqId === 'restore-output')?.status, 'ok', JSON.stringify(events.filter(event => event.type === 'notice' || event.reqId === 'restore-output')));
	assert(client.session.messages.some(message => message.toolCallId === call));
	await client.dispose(); client = undefined;
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: root, PI_WEB_TOKEN: 'fixture-token' } });
	socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws?token=fixture-token`);
	let state, ready = false;
	socket.on('message', raw => { const message = JSON.parse(raw); state = mergeSnapshot(state, message); if (message.type === 'ready') ready = true; });
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
	socket.send(JSON.stringify({ type: 'hello', clientId: 'http-output' }));
	for (let i = 0; i < 1500 && !ready; i++) await delay(20);
	assert(ready, harness.logs);
	const query = new URLSearchParams({ clientId: 'http-output', conversationId: state.conversationId, toolCallId: call });
	const url = `http://127.0.0.1:${harness.port}/api/tool-output?${query}`;
	assert.equal((await fetch(url)).status, 401);
	assert.equal((await fetch(url + '&token=fixture-token', { headers: { Origin: 'https://foreign.example' } })).status, 403);
	assert.equal((await fetch(url.replace(state.conversationId, 'foreign-conversation') + '&token=fixture-token')).status, 403);
	assert.equal((await fetch(url + '&token=fixture-token&outputId=artifact-999999')).status, 403);
	const listed = await (await fetch(url.replace('/api/tool-output?', '/api/tool-output-list?') + '&token=fixture-token')).json();
	assert(listed.some(item => item.default)); assert(!JSON.stringify(listed).includes(artifactDir));
	const response = await fetch(url + '&token=fixture-token'); assert.equal(response.status, 200);
	assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(captured));
	assert(response.headers.get('content-disposition').includes('attachment'));
	if (process.argv.includes('--browser')) {
		const { chromium } = await import('playwright-core'), { CHROME_PATH } = await import('./lib/chrome.mjs');
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const page = await browser.newPage({ acceptDownloads: true });
		await page.goto(`http://127.0.0.1:${harness.port}/?token=fixture-token`);
		const card = page.locator('[data-tool-call-id="native-output"]');
		await card.waitFor({ state: 'attached' });
		await page.locator('.process-group').filter({ has: card }).locator('.process-group-summary-line').click();
		await card.locator('.bash-row-head').click();
		const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: /下载输出|Download output/ }).click()]);
		assert.equal(hash(readFileSync(await download.path())), hash(captured));
		if (partial) await card.getByRole('status').filter({ hasText: /已截断|truncated/ }).waitFor();
		await page.screenshot({ path: `tests/scratch/omp-output-${partial ? 'partial' : 'full'}.png` });
		console.log(`PASS browser native command card downloads ${partial ? 'partial capture with explicit notice' : 'original output bytes'}`);
	}
	assert.equal(requests, calls, 'metadata, HTTP and browser downloads never dispatch a model request');
	console.log(`PASS OMP ${partial ? 'partial capture' : 'full native output'}: real spill/short fallback, 600 MiB streaming, all branches, card link, Stop without revival, ownership, symlinks, missing files and HTTP authentication`);
} finally {
	await browser?.close(); socket?.close(); await harness?.stop(); await client?.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
