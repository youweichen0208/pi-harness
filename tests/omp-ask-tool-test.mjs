/** Native model ask tool through RPC's HTML-form fallback, with real local SSE. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { mergeSnapshot } from "./lib/snapshots.mjs";

const root = mkdtempSync(join(tmpdir(), "omp-ask-tool-")), cwd = join(root, "project"), data = join(root, "data"), agent = join(data, "omp/agent");
mkdirSync(cwd); mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, ask: { timeout: 0, notify: "off" } }));
const html = `<form><p>Choose deployment settings.</p>
<fieldset><legend>Mode</legend><label><input type="radio" name="mode" value="fast">Fast</label><label><input type="radio" name="mode" value="safe" checked>Safe</label></fieldset>
<fieldset><legend>Features</legend><label><input type="checkbox" name="features" value="search" checked>Search</label><label><input type="checkbox" name="features" value="preview">Preview</label></fieldset>
<label>Notes <textarea name="notes">seed</textarea></label>
<label>Budget <input type="number" name="budget" min="1" value="2"></label>
<label>Nickname <input name="nickname" placeholder="A short name" required></label>
</form>`;
const requests = [], pending = new Map();
let harness, ws, browser, state, ready = false;
const provider = createServer(async (req, res) => {
	let body = ""; for await (const chunk of req) body += chunk;
	const request = JSON.parse(body); requests.push(request);
	const last = request.messages.at(-1)?.content;
	const ask = JSON.stringify(last).includes("ASK_FORM_FIXTURE");
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event("message_start", { message: { id: `m-${requests.length}`, type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
	if (ask) {
		event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `ask-${requests.length}`, name: "ask", input: {} } });
		event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ html }) } });
	} else {
		event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "FORM_DONE" } });
	}
	event("content_block_stop", { index: 0 });
	event("message_delta", { delta: { stop_reason: ask ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } });
	event("message_stop", {}); res.end();
});
async function wait(test, label = "native ask", timeout = 30000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) { const value = await test(); if (value) return value; await sleep(20); }
	throw Error(`Timeout: ${label}; requests=${requests.length}; pending=${JSON.stringify([...pending.values()])}; error=${state?.error ?? ""}`);
}
const send = message => ws.send(JSON.stringify(message));
const current = () => [...pending.values()].find(dialog => dialog.conversationId === state?.conversationId);
async function connect(wiki = false) {
	ws?.terminate(); state = undefined; ready = false; pending.clear();
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	ws.on("message", raw => { const message = JSON.parse(raw); state = mergeSnapshot(state, message);
		if (message.type === "ready") ready = true;
		if (message.type === "dialog") pending.set(message.id, message);
		if (message.type === "dialog_closed") pending.delete(message.id);
		if (message.type === "extension_ui_reset") for (const [id, dialog] of pending) if (dialog.conversationId === message.conversationId) pending.delete(id);
	});
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	send({ type: "hello", clientId: wiki ? "form-wiki" : "form-main", wiki });
	await wait(() => ready && state && !state.isStreaming, "ready");
}
async function reply(value) {
	const dialog = await wait(current);
	send({ type: "dialog_response", conversationId: state.conversationId, id: dialog.id, value });
	await wait(() => !pending.has(dialog.id), "dialog consumed");
}
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "anthropic-messages", baseUrl: `http://127.0.0.1:${port}`, apiKey: "fixture", models: [{ id: "fixture" }] } } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: data, PI_WEB_CWD: cwd } });
	await connect();
	send({ type: "prompt", text: "ASK_FORM_FIXTURE", requestId: crypto.randomUUID() });
	const mode = await wait(current);
	assert.equal(mode.kind, "select");
	assert.equal(mode.selectionMarker, "radio", "native model form must retain its selection marker");
	assert.equal(mode.initialIndex, 1, "the model's preselection controls initial focus");
	await reply("Fast");
	await wait(() => current() || requests.length > 1, "next field after Mode");
	assert(current(), `Native form stopped after its first field: ${JSON.stringify(requests.at(-1)?.messages.at(-1))}`);
	let features = await wait(current);
	assert.equal(features.selectionMarker, "checkbox"); assert.deepEqual(features.checkedIndices, [0]);
	assert.equal(features.markableCount, 3, "Done is an action, not a checkbox");
	await reply("Preview"); features = await wait(current); assert.deepEqual(features.checkedIndices, [0, 1]);
	await reply("Search"); features = await wait(current); assert.deepEqual(features.checkedIndices, [1]);
	await reply(features.args[0].find(label => label.startsWith("Other")));
	assert.equal((await wait(current)).kind, "input"); await reply("Extra feature");
	features = await wait(current); assert.deepEqual(features.checkedIndices, [1, 2]);
	await reply(features.args[0].find(label => label.includes("Done selecting")));
	const notes = await wait(current); assert.equal(notes.kind, "editor"); assert.equal(notes.args[0], "seed"); await reply("line one\nline two");
	assert.equal((await wait(current)).args[0], "2"); await reply("0");
	const invalid = await wait(current); assert.equal(invalid.args[0], "0", "native validation preserves rejected input"); assert(invalid.title.includes("Budget")); await reply("3");
	assert.equal((await wait(current)).kind, "input"); await reply("fixture name");
	await wait(() => requests.length === 2 && !state.isStreaming, "model receives completed form");
	const result = requests[1].messages.at(-1).content.find(block => block.type === "tool_result");
	assert(result && !result.is_error);
	const text = typeof result.content === "string" ? result.content : result.content.map(block => block.text ?? "").join("\n");
	assert(text.includes('"mode": "fast"') && text.includes('"budget": 3') && text.includes('"nickname": "fixture name"'), text);
	assert(text.includes('"preview"') && text.includes('"Extra feature"') && !text.includes('"search"'), text);
	assert(text.includes("line one\\nline two"), text);
	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core"), { CHROME_PATH } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath: CHROME_PATH });
		const page = await browser.newPage(); page.setDefaultTimeout(30000);
		await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "form-main"));
		await page.goto(`http://127.0.0.1:${harness.port}`);
		await page.locator(".inputbar textarea:not(:disabled)").waitFor();
		send({ type: "prompt", text: "ASK_FORM_FIXTURE", requestId: crypto.randomUUID() });
		const panel = page.locator('[data-dialog-kind="select"]');
		await panel.getByRole("radio", { name: "Safe", exact: true }).waitFor();
		await wait(async () => await panel.getByRole("radio", { name: "Safe", exact: true }).evaluate(el => el === document.activeElement));
		await page.keyboard.press("ArrowUp"); await page.keyboard.press("Enter");
		const search = panel.getByRole("checkbox", { name: "Search", exact: true }), preview = panel.getByRole("checkbox", { name: "Preview", exact: true });
		await search.waitFor(); assert.equal(await search.getAttribute("aria-checked"), "true");
		await preview.click(); await wait(async () => await preview.getAttribute("aria-checked") === "true");
		await page.reload(); await preview.waitFor(); assert.equal(await preview.getAttribute("aria-checked"), "true"); assert.equal(await search.getAttribute("aria-checked"), "true");
		await search.click(); await wait(async () => await search.getAttribute("aria-checked") === "false");
		assert.equal(await panel.getByRole("checkbox").count(), 3);
		await page.setViewportSize({ width: 390, height: 844 }); assert(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
		await panel.getByRole("button", { name: /Done selecting/ }).click();
		await page.locator('[data-dialog-kind="editor"]').waitFor();
		await page.locator('[data-dialog-kind="editor"] textarea').focus(); await page.keyboard.press("Escape");
		await wait(() => !current() && !state.isStreaming, "native ask cancellation");
		assert.equal(requests.length, 3, "cancelling the form aborts the native turn without another model call");
		await browser.close(); browser = undefined;
	}
	await connect(true);
	const beforeWiki = requests.length;
	send({ type: "prompt", text: "ASK_FORM_FIXTURE", requestId: crypto.randomUUID() });
	assert.equal((await wait(current)).selectionMarker, "radio");
	send({ type: "abort" }); await wait(() => !current() && !state.isStreaming, "Wiki Stop");
	await sleep(200); assert.equal(requests.length, beforeWiki + 1, "Stop never auto-resubmits the ask tool");
	// Explicitly reopen the stopped worker with a fixture-only native timeout.
	writeFileSync(join(agent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false }, ask: { timeout: 1, notify: "off" } }));
	const beforeTimeout = requests.length;
	send({ type: "prompt", text: "ASK_FORM_FIXTURE", requestId: crypto.randomUUID() });
	const timed = await wait(current);
	await wait(() => requests.length === beforeTimeout + 2 && !state.isStreaming && !current(), "native form timeout");
	const timeoutResult = requests.at(-1).messages.at(-1).content.find(block => block.type === "tool_result");
	assert(timeoutResult && !timeoutResult.is_error);
	const timeoutText = JSON.stringify(timeoutResult.content);
	for (const expected of ['safe', 'search', 'seed']) assert(timeoutText.includes(expected), timeoutText);
	assert(!timeoutText.includes("Extra feature"), "previous form answers cannot replace timeout defaults");
	send({ type: "dialog_response", conversationId: state.conversationId, id: timed.id, value: "Fast" });
	await sleep(200); assert.equal(requests.length, beforeTimeout + 2, "expired answers cannot resume the model");
	console.log("PASS native model ask: radio focus, checkbox state, Other, Done, text/editor validation, tool result, Wiki Stop, native timeout defaults and no automatic resubmission");
} finally {
	await browser?.close(); ws?.terminate(); await harness?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
