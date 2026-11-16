/** A detached Wiki window keeps its identity before and after asynchronous folder discovery. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
import { createOmpHistory } from './lib/omp-history-fixture.mjs';
import { mergeSnapshot } from './lib/snapshots.mjs';
import { openKnowledge } from './lib/open-knowledge.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'omp-wiki-bootstrap-')));
const data = join(root, 'data'), work = join(root, 'work'), library = join(root, 'library'), agent = join(data, 'omp/agent');
for (const directory of [work, library, agent]) mkdirSync(directory, { recursive: true });
writeFileSync(join(library, 'note.md'), '# Library\n\nThe document is ready.\n');
writeFileSync(join(work, 'note.md'), '# Work\n');
writeFileSync(join(agent, 'config.yml'), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
let harness, browser, releaseConfig;
const connections = [];
async function wait(predicate, label) {
	const end = Date.now() + 30000;
	while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(20); }
	throw Error(`Timed out: ${label}`);
}
async function connect(fields, clientId = randomUUID()) {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`), events = [];
	const client = { ws, clientId, events, state: undefined, send: message => ws.send(JSON.stringify(message)) };
	connections.push(client);
	ws.on('message', raw => { const event = JSON.parse(String(raw)); events.push(event); client.state = mergeSnapshot(client.state, event); });
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	client.send({ type: 'hello', clientId, ...fields });
	await wait(() => events.some(event => event.type === 'ready') && client.state, 'ready snapshot');
	return client;
}
async function changeFolder(client, cwd) {
	const requestId = randomUUID(); client.send({ type: 'set_cwd', path: cwd, requestId });
	const result = await wait(() => client.events.find(event => event.type === 'cwd_result' && event.requestId === requestId), 'folder result');
	assert.equal(result.ok, true, result.error);
	await wait(() => client.state.cwd === cwd && !client.state.isStreaming, 'folder snapshot');
	assert.equal(client.state.wiki, true, 'changing folders must retain Wiki identity');
	assert.equal(client.state.messages.length, 0, 'Wiki must never restore ordinary project history');
}
try {
	const history = await createOmpHistory({ dataDir: data, cwd: library, messages: [{ role: 'user', content: 'ordinary project history', timestamp: Date.now() }] });
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: work, PI_WEB_DATA_DIR: data } });
	// Legacy direct URLs still initialize Wiki and must survive folder navigation.
	const direct = await connect({ wikiCwd: work });
	assert.equal(direct.state.wiki, true);
	await changeFolder(direct, library);
	const selected = direct.state.conversationId;
	await changeFolder(direct, work); await changeFolder(direct, library);
	assert.equal(direct.state.conversationId, selected, 'returning to a folder reuses its Wiki conversation');
	// Knowledge-library popups announce their purpose before knowing their cwd.
	const popup = await connect({ wiki: true });
	assert.equal(popup.state.wiki, true, 'Wiki intent cannot depend on when configuration arrives');
	await changeFolder(popup, library);
	const response = await fetch(`http://127.0.0.1:${harness.port}/api/wiki`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'chat-document', clientId: popup.clientId, cwd: library, conversationId: popup.state.conversationId, path: 'note.md' }) });
	assert.equal(response.status, 200, await response.clone().text());
	const bound = await response.json();
	const normal = await connect({});
	normal.send({ type: 'set_cwd', path: library, requestId: 'normal-folder' });
	await wait(() => normal.events.some(event => event.type === 'cwd_result' && event.requestId === 'normal-folder'), 'normal folder');
	assert.equal(normal.state.wiki, false);
	assert.equal(normal.state.sessionFile, history.sessionFile);
	assert.notEqual(normal.state.sessionId, bound.sessionId);
	const denied = await fetch(`http://127.0.0.1:${harness.port}/api/wiki`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'chat-document', clientId: normal.clientId, cwd: library, conversationId: normal.state.conversationId, path: 'note.md' }) });
	assert.equal(denied.status, 400, 'ordinary clients are not silently converted by document requests');
	for (const value of ['true', 1, null, {}]) {
		const invalid = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
		const closed = new Promise(resolve => invalid.once('close', resolve));
		invalid.once('open', () => invalid.send(JSON.stringify({ type: 'hello', clientId: randomUUID(), wiki: value })));
		assert.equal(await closed, 4400, 'Wiki intent must be a boolean');
	}
	for (const client of connections) client.ws.terminate();
	await harness.stop();
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: work, PI_WEB_DATA_DIR: data } });
	const restored = await connect({ wiki: true }, popup.clientId);
	assert.equal(restored.state.wiki, true);
	assert.equal(restored.state.cwd, library);
	assert.equal(restored.state.sessionId, bound.sessionId, 'restarting restores the selected Wiki session');
	if (process.argv.includes('--browser')) {
		// The protocol client above intentionally still owns note.md's history.
		// Use a separate folder so this tests startup, not cross-window takeover.
		const browserLibrary = join(root, 'browser-library'); mkdirSync(browserLibrary);
		writeFileSync(join(browserLibrary, 'note.md'), '# Library\n\nThe document is ready.\n');
		writeFileSync(join(browserLibrary, 'other.md'), '# Other\n\nThe other document is ready.\n');
		const { chromium } = await import('playwright-core'); const { CHROME_PATH } = await import('./lib/chrome.mjs');
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const context = await browser.newContext(), page = await context.newPage();
		await page.goto(`http://127.0.0.1:${harness.port}`);
		await page.locator('.setup-modal .modal-close').click();
		const gate = new Promise(resolve => { releaseConfig = resolve; });
		await context.route('**/api/knowledge-library', async route => {
			if (route.request().postDataJSON()?.action === 'read') await gate;
			await route.continue();
		});
		const frames = [], hellos = [];
		context.on('page', child => child.on('websocket', socket => {
			socket.on('framesent', ({ payload }) => { const event = JSON.parse(String(payload)); if (event.type === 'hello') hellos.push(event); });
			socket.on('framereceived', ({ payload }) => frames.push(JSON.parse(String(payload))));
		}));
		const opening = context.waitForEvent('page');
		await openKnowledge(page, browserLibrary, 'note.md'); const wiki = await opening;
		await wait(() => frames.some(event => event.type === 'ready'), 'popup ready while config is held');
		assert.equal(hellos[0]?.wiki, true);
		assert.equal(hellos[0]?.wikiCwd, undefined, 'the test really holds folder discovery until after hello');
		assert(frames.filter(event => event.type === 'snapshot').every(event => event.state.wiki), 'no ordinary history flashes in the popup');
		releaseConfig();
		await wiki.locator('.setup-modal .modal-close').click();
		try { await wiki.locator('.wiki-prose .fp-rich-document').getByText('The document is ready.', { exact: true }).waitFor(); }
		catch (error) { console.error('Wiki bootstrap failure:', wiki.url(), (await wiki.locator('body').innerText()).slice(-2000)); throw error; }
		let releaseDocument, navigating = false;
		const documentGate = new Promise(resolve => { releaseDocument = resolve; });
		await context.route('**/api/wiki', async route => {
			const request = route.request().postDataJSON();
			if (request.action === 'chat-document' && request.path === 'other.md') { navigating = true; await documentGate; }
			await route.continue();
		});
		try {
			await wiki.locator('.wiki-tree-row[title="other.md"]').click();
			await wait(() => navigating, 'held document transition');
			assert.equal(await wiki.getByRole('button', { name: '退出 Wiki 模式', exact: true }).isDisabled(), true, 'close reflects pending navigation rather than ignoring clicks');
		} finally { releaseDocument(); }
		await wiki.locator('.wiki-prose .fp-rich-document').getByText('The other document is ready.', { exact: true }).waitFor();
		await wiki.reload();
		await wiki.locator('.wiki-prose .fp-rich-document').getByText('The other document is ready.', { exact: true }).waitFor();
		assert.equal(await page.locator('.wiki-window-shell').count(), 0, 'main window remains ordinary');
		await context.close();
	}
	console.log('PASS OMP Wiki bootstrap: delayed config, folder identity, ordinary-history isolation, document binding and refresh');
} finally {
	releaseConfig?.(); await browser?.close();
	for (const client of connections) client.ws.terminate();
	await harness?.stop(); rmSync(root, { recursive: true, force: true });
}
