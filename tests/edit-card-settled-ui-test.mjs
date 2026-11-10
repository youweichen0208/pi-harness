/**
 * An edit card must show its diff after the call settles.
 *
 * `tool_status` is pushed on `tool_execution_end`, before the tool result reaches
 * the transcript, so the card used to fold the instant `running` went false —
 * the reader saw the dot turn green and the diff disappear in the same breath.
 *
 * Option B: a settled edit keeps its diff open while it is the live edge of the
 * conversation (newest assistant reply, nothing after it), and folds once the
 * reply has moved past it. An explicit toggle always wins.
 *
 * The browser gets hand-built snapshots: the first one for the real conversation,
 * the rest as full `snapshot` frames so the reducer replaces the transcript
 * instead of applying a delta the fixture never sent.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 8963;
assert.equal(await portUp(port), false, `Port ${port} busy`);
const root = mkdtempSync(join(tmpdir(), 'pi-edit-live-'));
const cwd = join(root, 'workspace');
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, 'app.ts'), 'const value = "old";\n');

const diff = '-1 const value = "old";\n+1 const value = "new";';
const editCall = { id: 'edit', role: 'assistant', content: [{ type: 'toolCall', id: 'edit1', name: 'edit', argumentsText: JSON.stringify({ path: 'app.ts', oldText: 'const value = "old";', newText: 'const value = "new";' }) }] };
const userMsg = { id: 'user', role: 'user', content: [{ type: 'text', text: 'Change the value' }] };
const resultMsg = { id: 'edit-result', role: 'toolResult', toolCallId: 'edit1', details: { diff, firstChangedLine: 1 }, content: [] };
const running = [userMsg, editCall];
const settled = [...running, resultMsg];
const movedOn = [...settled, { id: 'next', role: 'assistant', content: [{ type: 'text', text: 'Done, value updated.' }] }];

let server, browser, socket, baseState;

try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = '';
	server.stdout.on('data', data => log += data);
	server.stderr.on('data', data => log += data);
	for (let n = 0; n < 100 && !await portUp(port); n++) await sleep(100);
	assert(await portUp(port), log);

	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	let conversationId;
	let phaseMessages = running;

	/** Reload with the next transcript: the first `snapshot` is authoritative. */
	const show = async (messages) => {
		phaseMessages = messages;
		await page.reload();
		await page.locator('.change-card').waitFor();
		await sleep(400);
	};
	const body = () => page.locator('.change-card[data-tool-call-id="edit1"] .change-card-body');
	const card = () => page.locator('.change-card[data-tool-call-id="edit1"]');

	await page.routeWebSocket('**/ws', route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(wire => upstream.send(wire));
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === 'snapshot') {
				conversationId = message.state.conversationId;
				baseState = { ...message.state, messages: phaseMessages, isStreaming: false, piConfigured: true };
				route.send(JSON.stringify({ ...message, state: baseState }));
				return;
			}
			// Everything after the first frame is fixture-driven.
			if (['snapshot_delta', 'tool_status', 'terminal_list'].includes(message.type)) return;
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${port}`);

	// 1) While the call runs, the diff is open.
	await card().waitFor();
	await body().waitFor();

	// 2) The dot turns green: the diff must stay open, not be yanked away.
	socket.send(JSON.stringify({ type: 'tool_status', conversationId, toolCallId: 'edit1', toolName: 'edit', isError: false, running: false, durationMs: 40 }));
	await page.waitForFunction(() => document.querySelector('.change-card[data-tool-call-id="edit1"]')?.className.includes('done'));
	assert.equal(await body().count(), 1, 'the diff stays open the moment the call settles');

	// 3) The result lands: still open, still green.
	await show(settled);
	assert.equal(await card().count(), 1, 'the settled edit stays in the stream');
	assert.equal(await page.locator('.change-card[data-tool-call-id="edit1"].done').count(), 1, 'it keeps the settled state');
	assert.equal(await body().count(), 1, 'the diff is still open after the result lands');

	// 4) The reply moves past it: now it folds to one row (option B).
	await show(movedOn);
	assert.equal(await body().count(), 0, 'it folds once the reply has moved past it');
	assert.match(await page.locator('.change-card[data-tool-call-id="edit1"] .change-card-head').innerText(), /app\.ts/);
	assert.match(await page.locator('.change-card[data-tool-call-id="edit1"] .change-counts').innerText(), /\+1/);

	// 5) An explicit toggle beats the automatic fold.
	await page.locator('.change-card[data-tool-call-id="edit1"] .change-card-toggle').click();
	await body().waitFor();
	await show(settled);
	assert.equal(await body().count(), 1, 'an explicit expand survives later updates');
	await page.locator('.change-card[data-tool-call-id="edit1"] .change-card-toggle').click();
	assert.equal(await body().count(), 0, 'an explicit collapse keeps it folded');

	assert.deepEqual(errors, [], 'no page errors');
	console.log('PASS a settled edit keeps its diff open until the reply moves past it');
} finally {
	await browser?.close().catch(() => {});
	server?.kill('SIGTERM');
	await sleep(300);
	rmSync(root, { recursive: true, force: true });
}
