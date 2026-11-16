/** Real browser -> WebSocket -> native OMP branch summary cancellation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { listenIsolated, startIsolatedHarness } from './lib/isolated-server.mjs';
import { mergeSnapshot } from './lib/snapshots.mjs';
const root = mkdtempSync(join(tmpdir(), 'omp-tree-ui-')), cwd = join(root, 'work'), data = join(root, 'data'), agent = join(data, 'omp/agent');
mkdirSync(cwd); mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ treeFilterMode: "user-only", skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false } }));
let harness, browser, ws, state, ready = false, hanging = false;
const requests = [], events = [];
const provider = createServer(async (req, res) => {
	let raw = ''; for await (const part of req) raw += part; requests.push(JSON.parse(raw));
	res.writeHead(200, { 'Content-Type': 'text/event-stream' });
	const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit('message_start', { message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	if (hanging) return;
	emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
	emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `TREE_RESPONSE_${requests.length}` } });
	emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }); emit('message_stop', {}); res.end();
});
const wait = async (predicate, label) => { for (let i = 0; i < 1500; i++) { if (await predicate()) return; await sleep(20); } throw Error(`Timeout ${label}; ${state?.errorMessage ?? ''}`); };
const send = message => ws.send(JSON.stringify(message));
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', models: [{ id: 'fixture', contextWindow: 200000 }] } } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: data, PI_WEB_CWD: cwd } });
	const origin = `http://127.0.0.1:${harness.port}`;
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	ws.on('message', raw => { const event = JSON.parse(raw); events.push(event); state = mergeSnapshot(state, event); if (event.type === 'ready') ready = true; });
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	send({ type: 'hello', clientId: 'tree-ui' }); await wait(() => ready && state && !state.isStreaming, 'ready');
	for (const text of ['First tree question', 'Second tree question']) {
		const count = requests.length; send({ type: 'prompt', text, requestId: crypto.randomUUID() });
		await wait(() => requests.length === count + 1 && !state.isStreaming && state.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes(`TREE_RESPONSE_${count + 1}`)), text);
	}
	const targetId = state.messages.find(message => message.role === 'assistant').entryId; assert(targetId);
	send({ type: 'tree_get', conversationId: state.conversationId, reqId: 'before' }); await wait(() => events.some(event => event.type === 'tree' && event.reqId === 'before'), 'original leaf');
	const beforeLeaf = events.find(event => event.type === 'tree' && event.reqId === 'before').leafId;
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(30000);
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(() => sessionStorage.setItem('pi-web-client-id', 'tree-ui'));
	await page.goto(origin); await page.locator('.inputbar textarea:not(:disabled)').waitFor();
	await page.evaluate(() => window.dispatchEvent(new Event('pi-tree-open')));
	await wait(async () => await page.locator('.session-tree-controls select').inputValue() === 'user-only', 'native initial filter');
	await page.locator('.session-tree-controls select').selectOption('default');
	const row = page.locator(`.tree-node[data-entry-id="${targetId}"]`); await row.waitFor();
	await row.getByRole('button', { name: '切换到这里', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: '切换到这里', exact: true });
	await dialog.getByText(/^将总结 \d+ 条记录$/).waitFor();
	const previewReply = events.findLast(event => event.type === 'tree_preview_result');
	assert(previewReply?.entryCount > 0); assert.equal(previewReply.commonAncestorId, targetId);
	assert.equal(await dialog.getByText(/^将总结 \d+ 条记录$/).textContent(), `将总结 ${previewReply.entryCount} 条记录`);
	await dialog.getByRole('radio', { name: '按自定义指令生成摘要', exact: true }).check();
	await dialog.getByRole('textbox', { name: '摘要指令', exact: true }).fill('BROWSER_SUMMARY_SENTINEL: preserve file changes.');
	hanging = true; const beforeSummary = requests.length;
	await dialog.getByRole('button', { name: '切换到这里', exact: true }).click();
	await wait(() => requests.length === beforeSummary + 1 && state.branchSummary, 'summary request');
	assert(JSON.stringify(requests.at(-1).messages).includes('BROWSER_SUMMARY_SENTINEL: preserve file changes.'));
	const firstOperation = state.branchSummary.operationId;
	const region = page.getByRole('region', { name: '正在生成分支摘要', exact: true }); await region.waitFor();
	// Refresh loses local request maps; the authoritative operation must still be cancellable.
	await page.reload(); await region.waitFor(); assert.equal(state.branchSummary.operationId, firstOperation);
	await page.setViewportSize({ width: 390, height: 844 });
	assert(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
	mkdirSync('tests/scratch', { recursive: true });
	for (const appearance of ['light', 'dark']) { await page.evaluate(value => document.documentElement.dataset.appearance = value, appearance); await page.screenshot({ path: `tests/scratch/omp-summary-cancel-${appearance}.png` }); }
	const cancel = region.getByRole('button', { name: '取消摘要', exact: true }); await cancel.focus(); await page.keyboard.press('Enter');
	await wait(() => !state.branchSummary && !state.isStreaming, 'summary cancelled'); await region.waitFor({ state: 'detached' });
	assert(events.some(event => event.type === 'tree_navigate_result' && event.status === 'aborted'));
	assert.equal(requests.length, beforeSummary + 1);
	send({ type: 'tree_get', conversationId: state.conversationId, reqId: 'after' }); await wait(() => events.some(event => event.type === 'tree' && event.reqId === 'after'), 'unchanged leaf');
	assert.equal(events.find(event => event.type === 'tree' && event.reqId === 'after').leafId, beforeLeaf);
	// An English reconnect shows the next operation; an old cancel cannot affect it.
	await page.evaluate(() => localStorage.setItem('pi-harness:lang', 'en')); await page.reload();
	const count = requests.length;
	send({ type: 'tree_navigate', conversationId: state.conversationId, reqId: 'next', targetId, summary: 'default' });
	await wait(() => requests.length === count + 1 && state.branchSummary, 'second summary');
	send({ type: 'tree_cancel_summary', conversationId: state.conversationId, reqId: 'stale', operationId: firstOperation });
	await wait(() => events.some(event => event.type === 'tree_cancel_result' && event.reqId === 'stale'), 'stale cancel result');
	assert(events.some(event => event.type === 'tree_cancel_result' && event.reqId === 'stale' && event.status === 'stale'));
	await page.getByRole('region', { name: 'Generating branch summary', exact: true }).getByRole('button', { name: 'Cancel summary', exact: true }).click();
	await wait(() => !state.branchSummary && !state.isStreaming, 'English cancellation');
	hanging = false; const beforeContinue = requests.length;
	send({ type: 'prompt', text: 'Continue after cancelling', requestId: crypto.randomUUID() });
	await wait(() => requests.length === beforeContinue + 1 && !state.isStreaming && state.messages.some(message => JSON.stringify(message.content).includes(`TREE_RESPONSE_${beforeContinue + 1}`)), 'continued task');
	// Keep the tree open while a second socket changes a bookmark. Revision
	// snapshots must refresh both the tree and transcript without reopening it.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.evaluate(() => window.dispatchEvent(new Event('pi-tree-open')));
	const panel = page.locator('.session-tree-panel'); await panel.waitFor();
	const firstUser = state.messages.find(message => message.role === 'user');
	const versionBeforeLabel = state.tree.revision;
	send({ type: 'tree_label', conversationId: state.conversationId, reqId: 'live-label', entryId: firstUser.entryId, label: 'Live bookmark' });
	await wait(() => state.tree.revision !== versionBeforeLabel, 'authoritative tree revision');
	await panel.locator('.tree-label').filter({ hasText: 'Live bookmark' }).waitFor();
	await page.locator('.message-tree-controls .tree-label').filter({ hasText: 'Live bookmark' }).waitFor();
	send({ type: 'tree_label', conversationId: state.conversationId, reqId: 'clear-live-label', entryId: firstUser.entryId, label: null });
	await panel.locator('.tree-label').filter({ hasText: 'Live bookmark' }).waitFor({ state: 'detached' });
	await page.locator('.message-tree-controls .tree-label').filter({ hasText: 'Live bookmark' }).waitFor({ state: 'detached' });
	const beforeEdit = requests.length;
	send({ type: 'edit_message', conversationId: state.conversationId, entryId: firstUser.entryId, text: 'Browser edited branch' });
	await wait(() => requests.length === beforeEdit + 1 && !state.isStreaming && state.messages.some(message => message.siblings?.count === 2), 'sibling controls');
	await panel.locator('.tree-node-preview span').filter({ hasText: 'Browser edited branch' }).waitFor();
	await panel.getByRole('button', { name: 'Close', exact: true }).click();
	await panel.waitFor({ state: 'detached' });
	await page.screenshot({ path: 'tests/scratch/omp-tree-state.png' });
	const previous = page.getByRole('button', { name: 'Previous branch', exact: true }); await previous.focus(); await page.keyboard.press('Enter');
	await wait(() => state.messages.some(message => message.content.some(block => block.text === 'Second tree question')), 'previous retained branch');
	assert.equal(requests.length, beforeEdit + 1, 'previous sibling does not call the model');
	await page.reload();
	await page.getByRole('button', { name: 'Next branch', exact: true }).click();
	await wait(() => state.messages.some(message => message.content.some(block => block.text === 'Browser edited branch')), 'next retained branch after reconnect');
	assert.equal(requests.length, beforeEdit + 1, 'next sibling does not call the model');
	// Stopped tree refresh/search uses a read-only process and preserves the
	// in-memory branch position, even when the disk's last append is elsewhere.
	await page.getByRole('button', { name: 'Previous branch', exact: true }).click();
	await wait(() => state.messages.some(message => message.content.some(block => block.text === 'Second tree question')), 'branch before Stop');
	const stoppedLeaf = state.tree.leafId;
	send({ type: 'abort' });
	const workerAvailable = async () => (await (await fetch(`${origin}/api/omp-mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ clientId: 'tree-ui', cwd, conversationId: state.conversationId, action: 'status' }) })).json()).available;
	await wait(async () => await workerAvailable() === false, 'worker stopped');
	send({ type: 'tree_get', conversationId: state.conversationId, reqId: 'stopped-leaf', filter: 'all' });
	await wait(() => events.some(event => event.type === 'tree' && event.reqId === 'stopped-leaf'), 'read-only tree');
	assert.equal(events.find(event => event.type === 'tree' && event.reqId === 'stopped-leaf').leafId, stoppedLeaf);
	// The first read awaits Stop, including the native session_exit append.
	const stoppedBytes = readFileSync(state.sessionFile);
	await page.evaluate(() => window.dispatchEvent(new Event('pi-tree-open')));
	await panel.locator('.session-tree-controls input').fill('Second tree');
	await panel.locator('.tree-node-preview span').filter({ hasText: 'Second tree question' }).waitFor();
	const stoppedTarget = panel.locator('.tree-node').filter({ hasText: 'Second tree question' });
	await stoppedTarget.getByRole('button', { name: 'Switch here', exact: true }).click();
	const stoppedDialog = page.getByRole('dialog', { name: 'Switch here', exact: true });
	await stoppedDialog.getByText(/^Summarize \d+ entries$/).waitFor();
	await stoppedDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	assert.equal(await workerAvailable(), false); assert.equal(requests.length, beforeEdit + 1);
	assert.deepEqual(readFileSync(state.sessionFile), stoppedBytes);
	assert.deepEqual(errors, []);
	console.log('PASS native summary cancellation browser: actual tree UI, reconnect, authoritative operation, keyboard, narrow themes, English, stale IDs, unchanged leaf and continued work without replay');
} finally { await browser?.close(); ws?.terminate(); await harness?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true }); }
