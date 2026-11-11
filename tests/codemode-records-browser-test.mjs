/** Mock wire messages, real UI; no external model calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { startIsolatedHarness } from './lib/isolated-server.mjs';
import { deriveTaskProgress } from '../dist/server/task-progress.js';
const root = mkdtempSync(join(tmpdir(), 'pi-cm-records-'));
const user = { id: 'u', role: 'user', content: [{ type: 'text', text: 'Inspect the project' }] };
const assistant = { id: 'a', role: 'assistant', content: [{ type: 'toolCall', name: 'codemode', id: 'cm', argumentsText: JSON.stringify({ code: 'await Promise.all([tools.read({path:"a"}), tools.read({path:"b"})]);' }) }] };
const calls = count => Array.from({ length: count }, (_, i) => ({ id: 'cm/?', name: i % 2 ? 'models.classify' : 'read', args: `{"path":"file-${i}.ts"}`, status: 'running' }));
let harness, browser;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_WEB_DATA_DIR: join(root, 'data') } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	mkdirSync('tests/scratch', { recursive: true });
	for (const [platform, width, lang] of [['web', 1400, 'zh'], ['darwin', 900, 'zh'], ['win32', 900, 'en']]) {
		const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
		page.setDefaultTimeout(6000);
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => { if (message.type() === 'error' && /same key|unique.*key/i.test(message.text())) errors.push(message.text()); });
		let socket, base, revision = 0, sequence = 0, messages = [user, assistant], streaming = true, plan, projection;
		const send = () => {
			const task = deriveTaskProgress(base.conversationId, messages, null, streaming);
			if (task && plan) task.plan = plan;
			socket.send(JSON.stringify({ type: 'snapshot', state: { ...base, codemode: projection, rev: ++revision, messages, streamingMessage: null, isStreaming: streaming, piConfigured: true, taskProgress: task } }));
		};
		const delta = data => socket.send(JSON.stringify({ type: 'tool_delta', conversationId: base.conversationId, seq: ++sequence, toolCallId: 'cm', toolName: 'codemode', delta: '', codemode: { calls: data, totalCalls: data.length } }));
		await page.routeWebSocket('**/ws', route => {
			socket = route; const upstream = route.connectToServer(); route.onMessage(raw => upstream.send(raw));
			upstream.onMessage(raw => { const message = JSON.parse(String(raw)); if (message.type === 'snapshot') { base = message.state; revision = Math.max(revision, base.rev); send(); } else if (message.type !== 'snapshot_delta') route.send(raw); });
		});
		await page.addInitScript(({ platform, lang }) => { if (platform !== 'web') window.electronAPI = { platform, windowAction() {}, onWindowState() { return () => {}; } }; localStorage.setItem('pi-left-collapsed', 'true'); localStorage.setItem('pi-harness:lang', lang); }, { platform, lang });
		await page.goto(`http://127.0.0.1:${harness.port}`);
		await page.locator('.header-task-progress').click();
		const sidebar = page.locator('.task-progress:visible');
		const group = sidebar.locator('[data-codemode-group="cm"]');
		await group.waitFor(); delta(calls(12));
		await group.locator('.cm-record-row').first().waitFor();
		assert.equal(await group.locator('.cm-record-row').count(), 8);
		assert.match(await group.locator('.cm-record-row').first().innerText(), /file-4/);
		await group.locator('.cm-record-heading').click(); delta(calls(13));
		assert.equal(await group.locator('.cm-record-heading').getAttribute('aria-expanded'), 'false');
		await group.locator('.cm-record-heading').click();
		await group.locator('.cm-record-content > .task-step-jump').first().click();
		assert.equal(await group.locator('.cm-record-row').count(), 13);
		const chatCard = page.locator('.codemode-card[data-tool-call-id="cm"]');
		if (width < 1000) await page.locator('.drawer-backdrop').click({ position: { x: 5, y: 5 } });
		if (await chatCard.locator('.codemode-head').getAttribute('aria-expanded') === 'true') await chatCard.locator('.codemode-head').click();
		if (width < 1000) await page.locator('.header-task-progress').click();
		await group.locator('.cm-record-row').last().click();
		await chatCard.locator('.codemode-tabs').waitFor();
		assert.equal(await chatCard.locator('.codemode-head').getAttribute('aria-expanded'), 'true');
		// Disconnect changes connectivity, not the authoritative run lifecycle.
		if (platform === 'web') {
			projection = { history: messages, live: [{ toolCallId: 'cm', details: { calls: calls(14), totalCalls: 14 } }] };
			await socket.close({ code: 1000, reason: 'regression disconnect' });
			await page.waitForTimeout(150);
			assert.match(await chatCard.locator('.codemode-state').innerText(), /Running/);
			assert.equal(await chatCard.locator('[aria-label="Unfinished"]').count(), 0);
			await page.waitForTimeout(1300);
			assert.match(await group.locator('.cm-record-status').innerText(), /Running/);
			assert.equal(await group.locator('.cm-record-row').count(), 14, 'reconnect snapshot restores details missed offline without another delta');
			projection = undefined;
		}
		const completed = calls(13).map((call, i) => ({ ...call, id: `cm/${i}`, status: i === 0 ? 'error' : 'ok', durationMs: 15 }));
		messages = [user, assistant, { id: 'r', role: 'toolResult', toolName: 'codemode', toolCallId: 'cm', content: [], isError: false, codemode: { calls: completed, totalCalls: 13 } }]; streaming = false;
		// The native plan list is gone; the derived step record is what the sidebar shows.
		plan = undefined;
		if (platform === 'web') await socket.close({ code: 1000, reason: 'completed while offline' }); else send();
		await group.getByText('Completed · contains failed calls', { exact: true }).waitFor();
		assert.equal(await group.locator('.cm-record-heading').getAttribute('aria-expanded'), 'true');
		// The native plan list is gone, so codemode records are the only sidebar listing.
		assert.equal(await sidebar.locator('.task-plan-list, .task-plan-step').count(), 0);
		const large = calls(256).map(call => ({ ...call, status: 'ok' }));
		messages[2] = { ...messages[2], codemode: { calls: large, totalCalls: 300 } }; send();
		await group.locator('.cm-record-limit').filter({ hasText: '256/300' }).waitFor();
		await group.locator('.cm-record-heading').click();
		assert(await group.locator('.cm-record-limit').isVisible(), 'transmission limit stays visible even when folded');
		await group.locator('.cm-record-heading').click();
		await page.screenshot({ path: `tests/scratch/codemode-records-${platform}.png` });
		assert(await sidebar.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
		// Explicit cancelled entries and missing terminal metadata never become successful.
		messages[2] = { ...messages[2], codemode: { calls: [{ ...calls(1)[0], status: 'cancelled' }, calls(1)[0]], totalCalls: 2 } }; send();
		await group.locator('[aria-label="Cancelled"]').waitFor(); await group.locator('[aria-label="Unfinished"]').waitFor();
		messages.push({ ...user, id: 'u2' }); send(); await group.waitFor({ state: 'detached' });
		// Restoring historical state reconstructs its group, initially folded.
		messages.pop(); send(); await group.waitFor();
		assert.equal(await group.locator('.cm-record-heading').getAttribute('aria-expanded'), 'false');
		await group.locator('.cm-record-heading').click();
		assert.equal(await group.locator('.cm-record-row').count(), 2);
		assert.deepEqual(errors, []);
		await page.close();
	}
	console.log('PASS Codemode sidebar: live updates, stable keys, folding, history, limits, partial failure, plan independence and chat jumps (Web/macOS/Windows shells)');
} finally { await browser?.close(); await harness?.stop(); rmSync(root, { recursive: true, force: true }); }
