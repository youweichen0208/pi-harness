/** Persisted native session + real snapshot/tree routes. No prompts or model calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
const root = mkdtempSync(join(tmpdir(), 'pi-codemode-history-'));
const cwd = join(root, 'work'), agent = join(root, 'agent');
mkdirSync(cwd); mkdirSync(agent);
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 64000, maxTokens: 1024, input: ['text'] }] } } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
const manager = SessionManager.create(cwd, join(root, 'sessions'));
const user = manager.appendMessage({ role: 'user', content: 'Inspect project', timestamp: 1 });
manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'history-cm', name: 'codemode', arguments: { code: 'text("original script")' } }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 2 });
const resultId = manager.appendMessage({ role: 'toolResult', toolCallId: 'history-cm', toolName: 'codemode', isError: false, content: [{ type: 'text', text: 'Original output retained' }], details: { calls: [{ id: 'history-cm/read', name: 'read', args: '{"path":"a.ts"}', status: 'ok', durationMs: 10 }] }, timestamp: 3 });
const compact = manager.appendCompaction('Entire task summarized', null, 10000);
let harness, browser, upstream, state, initialized = false;
const wire = [], outgoing = [], errors = [];
async function wait(predicate) {
	for (let i = 0; i < 500; i++) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
	throw new Error('Timeout: ' + predicate);
}
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_CODING_AGENT_DIR: agent, PI_WEB_DATA_DIR: join(root, 'data') } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
	page.on('pageerror', error => errors.push(error.message));
	await page.routeWebSocket('**/ws', route => {
		upstream = route.connectToServer();
		route.onMessage(raw => { outgoing.push(JSON.parse(String(raw))); upstream.send(raw); });
		upstream.onMessage(raw => {
			const message = JSON.parse(String(raw)); wire.push(message);
			if (message.type === 'snapshot') state = message.state;
			if (message.type === 'snapshot_delta' && state) state = { ...state, ...message.state, messages: [...state.messages, ...message.appended] };
			route.send(raw);
			if (message.type === 'snapshot' && !initialized) { initialized = true; upstream.send(JSON.stringify({ type: 'switch_session', path: manager.getSessionFile() })); }
		});
	});
	await page.goto(`http://127.0.0.1:${harness.port}`);
	await wait(() => state?.sessionFile === manager.getSessionFile() && state.codemode?.history.some(message => message.toolCallId === 'history-cm'));
	assert(!state.messages.some(message => message.role === 'user'));
	assert(!JSON.stringify(state.codemode).includes('Original output retained'));
	await page.locator('.header-task-progress').click();
	const group = page.locator('.task-progress:visible [data-codemode-group="history-cm"]');
	await group.waitFor();
	assert.equal(await group.locator('.cm-record-heading').getAttribute('aria-expanded'), 'false');
	await wait(() => !state.tree?.verifying);
	const leafBeforeRead = state.tree.leafId;
	await group.locator('.cm-record-heading').click(); await group.locator('.cm-record-row').click();
	const dialog = page.locator('.cm-history-dialog');
	await dialog.locator('.codemode-call').waitFor();
	await dialog.getByRole('tab', { name: /脚本|Script/ }).click();
	assert.match(await dialog.innerText(), /original script/);
	await dialog.getByRole('tab', { name: /输出|Output/ }).click();
	assert.match(await dialog.innerText(), /Original output retained/);
	assert.equal(state.tree.leafId, leafBeforeRead, 'read must not navigate');
	await page.setViewportSize({ width: 900, height: 800 });
	assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
	mkdirSync('tests/scratch', { recursive: true });
	await page.screenshot({ path: 'tests/scratch/codemode-history-dialog.png' });
	await page.setViewportSize({ width: 1400, height: 950 });
	assert(!outgoing.some(message => ['prompt', 'tree_navigate'].includes(message.type)));
	await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
	await page.reload();
	await page.locator('.header-task-progress').click(); await group.waitFor();
	assert.equal(await group.locator('.cm-record-heading').getAttribute('aria-expanded'), 'false');
	await wait(() => !state.tree?.verifying);
	upstream.send(JSON.stringify({ type: 'tree_navigate', conversationId: state.conversationId, reqId: 'away', targetId: user, summary: 'none' }));
	await wait(() => wire.some(message => message.reqId === 'away' && message.status === 'ok'));
	await group.waitFor({ state: 'detached' });
	upstream.send(JSON.stringify({ type: 'tree_content', conversationId: state.conversationId, reqId: 'stale', entryId: resultId, codemodeToolCallId: 'history-cm' }));
	assert.equal((await wait(() => wire.find(message => message.reqId === 'stale'))).status, 'error');
	upstream.send(JSON.stringify({ type: 'tree_navigate', conversationId: state.conversationId, reqId: 'restore', targetId: compact, summary: 'none' }));
	await wait(() => wire.some(message => message.reqId === 'restore' && message.status === 'ok')); await group.waitFor();
	assert.deepEqual(errors, []);
	console.log('PASS native compaction snapshots, metadata bounds, read-only card, reload and branch isolation (zero model calls)');
} finally { await browser?.close(); await harness?.stop(); rmSync(root, { recursive: true, force: true }); }
