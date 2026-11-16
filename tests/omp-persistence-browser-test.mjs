import { mergeSnapshot } from "./lib/snapshots.mjs";
/** Browser warnings/reopen use native storage events, not fabricated UI state. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness, listenIsolated } from './lib/isolated-server.mjs';
import { testEnv } from './lib/test-env.mjs';
import { OmpSession } from '../dist/server/omp/session.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-persistence-ui-'))), dataDir = join(root, 'data'), cwd = join(root, 'project'), agent = join(dataDir, 'omp/agent');
for (const path of [cwd, agent]) mkdirSync(path, { recursive: true });
const requests = [];
let finishHeld, blockedDirectory, harness, browser, contender, page;
const provider = createServer(async (req, res) => {
	let raw = ''; for await (const part of req) raw += part;
	const request = JSON.parse(raw); requests.push(request);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	const finish = () => {
		emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
		emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Persistence fixture reply.' } });
		emit('content_block_stop', { index: 0 });
		emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
		emit('message_stop', {}); res.end();
	};
	if (JSON.stringify(request.messages.filter(message => message.role === 'user').at(-1)).includes('HOLD_FOR_FAILURE')) finishHeld = finish;
	else finish();
});
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
	writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, retry: { enabled: true }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: cwd } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await page.addInitScript({ content: `window.mergeFixtureSnapshot = ${mergeSnapshot.toString()};` });
	await page.addInitScript(() => {
		const NativeSocket = window.WebSocket;
		window.WebSocket = class extends NativeSocket {
			constructor(...args) {
				super(...args); window.fixtureSocket = this;
				this.addEventListener('message', event => {
					const message = JSON.parse(event.data);
					window.fixtureState = window.mergeFixtureSnapshot(window.fixtureState, message);
					if (message.type === 'tree_navigate_result') (window.fixtureTreeResults ??= []).push(message);
				});
			}
		};
	});
	const send = message => page.evaluate(message => window.fixtureSocket.send(JSON.stringify(message)), message);
	await page.goto(`http://127.0.0.1:${harness.port}`); await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await send({ type: 'set_model', modelId: 'fixture/fixture' }); await page.waitForFunction(() => window.fixtureState?.model?.id === 'fixture');
	await send({ type: 'prompt', requestId: 'seed', text: 'Saved seed' });
	await page.waitForFunction(() => window.fixtureState?.messages.some(message => message.role === 'assistant') && !window.fixtureState.isStreaming);
	const firstFile = await page.evaluate(() => window.fixtureState.sessionFile);
	await send({ type: 'abort' });
	// The explicit client Stop releases its native process and ownership lease.
	await page.waitForFunction(async () => {
		const { clientId, cwd, conversationId } = window.fixtureState;
		const response = await fetch('/api/omp-mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, cwd, conversationId, action: 'status' }) });
		return (await response.json()).available === false;
	});
	contender = new OmpSession({ conversationId: 'competing-owner', dataDir, cwd, sessionFile: firstFile, model: 'fixture/fixture', env: testEnv(), onChange() {} });
	await contender.open(); await contender.command('set_label', { entryId: contender.state.messages.find(message => message.role === 'user').entryId, label: 'other owner' });
	const preserved = readFileSync(firstFile, 'utf8');
	await send({ type: 'prompt', requestId: 'relocated', text: 'Continue while original has another owner' });
	await page.waitForFunction(() => window.fixtureState?.sessionPersistence?.relocation && !window.fixtureState.isStreaming);
	const warning = page.locator('.session-persistence'); await warning.waitFor();
	assert((await warning.innerText()).includes('保留原文件'));
	await warning.locator('summary').click(); assert((await warning.innerText()).includes(firstFile));
	assert.equal(readFileSync(firstFile, 'utf8'), preserved);
	await contender.close(); contender = undefined;
	await warning.getByRole('button', { name: '关闭', exact: true }).click();
	await send({ type: 'prompt', requestId: 'held', text: 'HOLD_FOR_FAILURE' });
	for (let i = 0; i < 500 && !finishHeld; i++) await new Promise(resolve => setTimeout(resolve, 20));
	assert(finishHeld);
	blockedDirectory = dirname(await page.evaluate(() => window.fixtureState.sessionFile));
	renameSync(blockedDirectory, blockedDirectory + '.saved'); writeFileSync(blockedDirectory, 'fixture storage obstruction');
	const before = requests.length; finishHeld();
	await page.waitForFunction(() => window.fixtureState?.sessionPersistence?.failed && !window.fixtureState.isStreaming);
	await warning.waitFor(); assert((await warning.innerText()).includes('尚未保存的消息可能丢失'));
	const reopen = warning.getByRole('button', { name: '重新读取已保存历史', exact: true });
	await reopen.click(); await page.waitForFunction(() => window.fixtureState?.sessionPersistence?.failed && !window.fixtureState.isStreaming);
	assert.equal(requests.length, before);
	await page.screenshot({ path: '/tmp/omp-persistence-failed.png', animations: 'disabled' });
	rmSync(blockedDirectory); renameSync(blockedDirectory + '.saved', blockedDirectory); blockedDirectory = undefined;
	await reopen.click(); await page.waitForFunction(() => window.fixtureState?.sessionPersistence?.failed === false && !window.fixtureState.isStreaming);
	assert.equal(requests.length, before, 'explicit reopen does not call the model');
	await send({ type: 'prompt', requestId: 'recovered', text: 'Manual continuation after repair' });
	await page.waitForFunction(() => window.fixtureState?.messages.some(message => message.role === 'user' && message.content.some(block => block.text === 'Manual continuation after repair')) && !window.fixtureState.isStreaming);
	assert.equal(requests.length, before + 1);
	finishHeld = undefined;
	await send({ type: 'prompt', requestId: 'external-held', text: 'HOLD_FOR_FAILURE external edit' });
	for (let i = 0; i < 500 && !finishHeld; i++) await new Promise(resolve => setTimeout(resolve, 20));
	assert(finishHeld);
	const externalFile = await page.evaluate(() => window.fixtureState.sessionFile);
	const original = readFileSync(externalFile, 'utf8'), foreign = original.replace('Saved seed', 'Saved edit');
	assert.notEqual(original, foreign); assert.equal(Buffer.byteLength(original), Buffer.byteLength(foreign));
	writeFileSync(externalFile, foreign);
	await page.waitForFunction(() => window.fixtureState?.sessionPersistence?.externallyModified && !window.fixtureState.isStreaming);
	await warning.waitFor(); assert((await warning.innerText()).includes('其他程序修改'));
	assert.equal(readFileSync(externalFile, 'utf8'), foreign);
	const beforeExternalReopen = requests.length;
	const previousPort = harness.port, previousPid = harness.child.pid;
	await harness.stop();
	rmSync(externalFile); // Missing failed history must not silently become an empty new conversation.
	harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: cwd }, nextPort: () => previousPort, attempts: 1 });
	assert.notEqual(harness.child.pid, previousPid);
	await page.reload(); await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await page.waitForFunction(() => window.fixtureState?.sessionPersistence?.externallyModified);
	assert.equal(await page.evaluate(() => window.fixtureState.sessionFile), externalFile);
	await warning.waitFor(); assert((await warning.innerText()).includes('其他程序修改'));
	assert.equal(await page.locator('[role="dialog"]').count(), 0, 'a blocked history is not an unconfigured model setup');
	assert.equal(requests.length, beforeExternalReopen, 'restarting the server must not resume the failed task');
	await reopen.click();
	await page.waitForFunction(() => window.fixtureTreeResults?.some(result => result.status === 'error'));
	assert.equal(await page.evaluate(() => window.fixtureState.sessionPersistence.failed), true);
	writeFileSync(externalFile, foreign);
	await reopen.click(); await page.waitForFunction(() => window.fixtureState?.sessionPersistence?.failed === false && !window.fixtureState.isStreaming);
	assert.equal(requests.length, beforeExternalReopen);
	assert.equal(readFileSync(externalFile, 'utf8'), foreign, 'explicit reopening does not rewrite the edited history');
	console.log('PASS OMP persistence browser: native relocation, save failure, external edit, server restart retains restriction and explicit recovery never replays');
} catch (error) {
	console.error(harness?.logs); console.error(await page?.locator('body').innerText().catch(() => '')); throw error;
} finally {
	if (blockedDirectory) { rmSync(blockedDirectory, { force: true }); renameSync(blockedDirectory + '.saved', blockedDirectory); }
	await contender?.close(); await browser?.close(); await harness?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
