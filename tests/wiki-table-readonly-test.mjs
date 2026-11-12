// Read-only table interaction: while the wiki conversation streams (or the
// document otherwise loads read-only), the editor must not pretend to offer
// structural gestures it will refuse — no column/row highlight is painted and
// the right-click menu stays closed, while the whole-table frame gesture
// remains available for copying. See docs/adr/0007-table-structure-editing.md
// (「后续修正」第六条: the painted highlight made read-only look interactive).
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME_PATH } from './lib/chrome.mjs';
import { portUp } from './lib/port-utils.mjs';
import { openKnowledge } from './lib/open-knowledge.mjs';
import { testEnv } from './lib/test-env.mjs';

const port = 9383, mockPort = 9384;
assert.equal(await portUp(port), false);
const base = mkdtempSync(join(tmpdir(), 'pi-wiki-table-readonly-'));
mkdirSync(join(base, 'agent'));
writeFileSync(join(base, 'note.md'), '# Read only\n\n| Name | Note |\n| --- | --- |\n| a | 1 |\n');

// Every completion streams slowly, so the conversation stays busy long enough
// to exercise the read-only window deterministically.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mock = http.createServer((req, res) => {
	if (!req.url.includes("/chat/completions")) { res.writeHead(404).end(); return; }
	let body = "";
	req.on("data", chunk => body += chunk);
	req.on("end", () => {
		const payload = JSON.parse(body);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const chunk = delta => res.write(`data: ${JSON.stringify({ id: "table-readonly", object: "chat.completion.chunk", created: Date.now(), model: payload.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		chunk({ content: "slow" });
		setTimeout(() => {
			chunk({ content: "done" });
			res.write(`data: ${JSON.stringify({ id: "table-readonly", object: "chat.completion.chunk", created: Date.now(), model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		}, 8000);
	});
});
await new Promise(resolve => mock.listen(mockPort, "127.0.0.1", resolve));

writeFileSync(join(base, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'unused', models: [{ id: 'unused', name: 'Unused', input: ['text'], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(base, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
writeFileSync(join(base, 'agent/auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'unused' } }));

let server, browser;
try {
	server = spawn(process.execPath, ['dist/server/index.js'], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: '', PI_WEB_CWD: base, PI_WEB_DATA_DIR: join(base, 'data'), PI_CODING_AGENT_DIR: join(base, 'agent') }, stdio: 'ignore' });
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(20000);
	const popup = page.context().waitForEvent('page');
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('.conn-dot.ok').first().waitFor({ state: 'attached' });
	await openKnowledge(page, base, 'note.md');
	const wiki = await popup;
	wiki.setDefaultTimeout(20000);
	const editor = wiki.locator('.wiki-prose .fp-rich-document');
	await editor.waitFor();
	const table = editor.locator('table').first();
	await table.waitFor();
	const editable = () => editor.evaluate(node => node.getAttribute('contenteditable'));
	assert.equal(await editable(), 'true', 'the idle document is editable');

	// Send a prompt through 问 pi; the conversation then streams for ~8s and the
	// workbench locks the document (WikiWorkbench: writingBlocked → readOnly).
	await wiki.locator('.wiki-ask-toggle').click();
	const input = wiki.locator('.wiki-agent-chat textarea, .wiki-agent-chat [contenteditable="true"]').first();
	await input.waitFor();
	await input.fill('SLOW');
	await wiki.keyboard.press('Enter');

	let flipped = false;
	for (let i = 0; i < 100; i++) { if ((await editable()) === 'false') { flipped = true; break; } await sleep(100); }
	assert(flipped, 'a streaming conversation must flip the document editor read-only');

	// No table menu while read-only — and the press must not leave a painted
	// column/row target behind (the old bug: the highlight made the read-only
	// surface look interactive, so the missing menu read as "broken").
	await table.locator('tbody td:not([data-rich-gutter])').first().click({ button: 'right' });
	await sleep(400);
	assert.equal(await wiki.locator('.fp-table-menu').count(), 0, 'no structure menu while the document is read-only');
	// The header's top band is the column affordance; read-only it must paint nothing.
	const headerBand = async () => {
		const box = await table.locator('th:not([data-rich-gutter])').first().boundingBox();
		await wiki.mouse.click(box.x + box.width / 2, box.y + 2);
		await sleep(250);
	};
	await headerBand();
	assert.equal(await wiki.locator('[data-column-target]').count(), 0, 'the header band paints no column highlight while read-only');

	// The gutter press falls through to the whole-table frame gesture: selecting
	// the table stays useful read-only, because it is a copy gesture.
	await table.locator('tbody td[data-rich-gutter]').first().click();
	await sleep(200);
	assert.equal(await wiki.locator('table[data-table-selected]').count(), 1, 'the gutter press selects the whole table for copying while read-only');

	// Once the stream settles the document becomes editable again and every
	// gesture comes back.
	for (let i = 0; i < 150; i++) { if ((await editable()) === 'true') break; await sleep(200); }
	assert.equal(await editable(), 'true', 'the editor returns to editable after the stream');
	await editor.locator('p').last().click();
	await table.locator('tbody td:not([data-rich-gutter])').first().click({ button: 'right' });
	await wiki.locator('.fp-table-menu').waitFor();
	await wiki.keyboard.press('Escape');
	await wiki.locator('.fp-table-menu').waitFor({ state: 'detached' });
	await headerBand();
	assert.equal(await wiki.locator('[data-column-target]').count(), 2, 'the header band selects its column again once editable');

	console.log('PASS table read-only interaction: no painted targets or menu while streaming, frame copy gesture kept, gestures restored after');
} finally {
	await browser?.close();
	server?.kill('SIGTERM');
	mock.close();
	await sleep(300);
	try { rmSync(base, { recursive: true, force: true }); } catch {}
}
