/** Real native extension UI over WebSocket. No model response or SDK patch. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { testEnv } from "./lib/test-env.mjs";
import { mergeSnapshot } from "./lib/snapshots.mjs";

const root = mkdtempSync(join(tmpdir(), "omp-extension-ui-")), data = join(root, "data"), cwd = join(root, "workspace"), agent = join(data, "omp/agent");
mkdirSync(cwd); mkdirSync(join(agent, "extensions"), { recursive: true });
writeFileSync(join(agent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
writeFileSync(join(agent, "extensions", "ui.js"), `export default api => {
 api.registerCommand("fixture-ui", { handler: async (args, ctx) => {
  ctx.ui.setWidget("same", [args]); ctx.ui.setStatus("same", args); ctx.ui.setTitle("title-" + args);
  ctx.ui.notify("notice-" + args, "warning");
  api.sendMessage({ customType: "fixture", content: "fixture-" + args, display: true });
  void ctx.ui.confirm("permission-" + args, "Allow?").then(value => ctx.ui.notify("answer-" + args + ":" + value));
 }});
 api.registerCommand("fixture-ask", { handler: async (args, ctx) => {
  if (!ctx.ui.askDialog) throw Error("Native ask opt-in missing");
  const result = await ctx.ui.askDialog([
   { id: "single", header: "Design", question: "Choose a style", options: [{ label: "Simple", description: "Less detail", preview: "<safe-preview>" }, { label: "Detailed" }], recommended: 0 },
   { id: "multi", header: "Features", question: "Choose features", options: [{ label: "Search" }, { label: "Preview" }], multi: true, recommended: 1 },
   { id: "text", question: "Any notes?", options: [] }
  ], args === "timeout" ? {timeout: 500} : undefined);
  ctx.ui.notify("ask-result:" + JSON.stringify(result));
 }});
 api.registerCommand("fixture-clear-ui", { handler: async (_args, ctx) => { ctx.ui.setWidget("same", undefined); ctx.ui.setStatus("same", undefined); ctx.ui.setTitle(""); } });
 api.registerCommand("fixture-editor", { handler: async (_args, ctx) => { const text = await ctx.ui.editor("multiline", "first\\nsecond"); if (text !== undefined) ctx.ui.setEditorText(text); } });
 api.registerCommand("fixture-select", { handler: async (_args, ctx) => { void ctx.ui.select("choose", ["one", "two"]).then(value => ctx.ui.notify("selected:" + value)); } });
 api.registerCommand("fixture-details", { handler: async (_args, ctx) => { const result = await ctx.ui.select("Details", [{label:"Brief",description:"Short description"},{label:"Verbose",description:"Long description"}], {initialIndex:1}); ctx.ui.notify("details:"+result); } });
 api.registerCommand("fixture-secret", { handler: async (_args, ctx) => { const result = await ctx.ui.input("Secret input", "", {secret:true}); ctx.ui.notify("secret:"+(result === "fixture-secret-value")); } });
 api.registerCommand("fixture-timeout", { handler: async (_args, ctx) => { void ctx.ui.input("timeout", "", {timeout: 200}).then(value => ctx.ui.notify("timeout:" + value)); } });
};`);
let calls = 0, harness, ws, state, browser;
const provider = createServer((req, res) => { calls++; req.resume(); res.writeHead(500); res.end(); });
let wire = [];
const send = message => ws.send(JSON.stringify(message));
async function wait(predicate, label = "event") {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) { const value = predicate(); if (value) return value; await sleep(20); }
	throw Error(`Timed out: ${label}; received ${wire.map(event => event.type).join(",")}`);
}
const event = (type, predicate = () => true) => wait(() => wire.find(message => message.type === type && predicate(message)), type);
async function connect(hello = {}) {
	wire = []; state = undefined;
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	ws.on("message", raw => { const message = JSON.parse(String(raw)); wire.push(message); state = mergeSnapshot(state, message); });
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	send({ type: "hello", clientId: "native-ui", ...hello }); await event("ready");
}
async function command(text) {
	send({ type: "prompt", text, requestId: crypto.randomUUID() });
}
const answer = (conversationId, id, value) => send({ type: "dialog_response", conversationId, id, value });
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "anthropic-messages", baseUrl: `http://127.0.0.1:${port}`, apiKey: "unused", models: [{ id: "fixture" }] } } }));
	const env = testEnv({ PI_WEB_DATA_DIR: data, PI_WEB_CWD: cwd });
	for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
	harness = await startIsolatedHarness({ env }); await connect();
	const a = state.conversationId;
	await command("/fixture-ui A");
	const da = await event("dialog", message => message.title === "permission-A");
	assert.equal(da.conversationId, a);
	assert.equal((await event("widgets", message => message.conversationId === a && message.widgets.length)).widgets[0].lines[0], "A");
	assert.equal((await event("statuses", message => message.conversationId === a && message.statuses.length)).statuses[0].text, "A");
	assert.equal((await event("extension_title", message => message.conversationId === a)).title, "title-A");
	const notice = await event("notice", message => message.text === "notice-A"); assert.equal(notice.conversationId, a); assert.equal(notice.level, "warning");
	await wait(() => !state.isStreaming && state.messages.length > 0);
	send({ type: "new_chat" }); await wait(() => state.conversationId !== a && !state.isStreaming);
	const b = state.conversationId;
	await command("/fixture-ui B"); const db = await event("dialog", message => message.title === "permission-B");
	assert.notEqual(da.id, db.id);
	answer(a, da.id, true); answer(b, da.id, true); answer(undefined, db.id, true); answer(b, db.id, "true");
	await sleep(150); assert(!wire.some(message => message.type === "dialog_closed" && [da.id, db.id].includes(message.id)), "wrong owner or type cannot answer a native dialog");
	answer(b, db.id, false); await event("notice", message => message.text === "answer-B:false" && message.conversationId === b);
	ws.terminate(); await connect();
	assert.equal((await event("dialog")).id, da.id);
	await event("widgets", message => message.conversationId === a && message.widgets[0]?.lines[0] === "A");
	await event("statuses", message => message.conversationId === b && message.statuses[0]?.text === "B");
	assert(!wire.some(message => message.type === "dialog" && message.id === db.id));
	send({ type: "switch_conversation", id: a }); await wait(() => state.conversationId === a);
	answer(a, da.id, true); await event("notice", message => message.text === "answer-A:true");
	await command("/fixture-select"); const select = await event("dialog", message => message.title === "choose");
	answer(a, select.id, "not-offered"); await sleep(100); assert(!wire.some(message => message.type === "dialog_closed" && message.id === select.id));
	answer(a, select.id, "two"); await event("notice", message => message.text === "selected:two");
	await command("/fixture-details"); const detailed = await event("dialog", message => message.title === "Details");
	assert.deepEqual(detailed.optionDetails, [{description:"Short description"},{description:"Long description"}]); assert.equal(detailed.initialIndex, 1);
	answer(a, detailed.id, "Verbose"); await event("notice", message => message.text === "details:Verbose"); await wait(() => !state.isStreaming);

	await command("/fixture-editor"); const editor = await event("dialog", message => message.title === "multiline");
	assert.equal(editor.args[0], "first\nsecond");
	answer(a, editor.id, { invalid: true }); await sleep(100); assert(!wire.some(message => message.type === "dialog_closed" && message.id === editor.id));
	answer(a, editor.id, "edited\nmultiline");
	await event("extension_editor", message => message.text === "edited\nmultiline" && message.conversationId === a);
	await wait(() => !state.isStreaming);
	await command("/fixture-timeout"); const timed = await event("dialog", message => message.title === "timeout");
	await event("dialog_closed", message => message.id === timed.id); await event("notice", message => message.text === "timeout:undefined");
	await wait(() => !state.isStreaming);
	await command("/fixture-ui stopping"); const stopped = await event("dialog", message => message.title === "permission-stopping");
	send({ type: "abort" }); await event("dialog_closed", message => message.id === stopped.id); await event("extension_ui_reset", message => message.conversationId === a);
	await wait(() => !state.isStreaming);
	wire = []; answer(a, stopped.id, true); await sleep(100); assert(!wire.some(message => message.type === "notice" && message.text === "answer-stopping:true"));
	ws.terminate(); await connect();
	assert(!wire.some(message => message.type === "dialog"));
	assert(!wire.some(message => message.type === "widgets" && message.conversationId === a && message.widgets.length));
	await event("widgets", message => message.conversationId === b && message.widgets[0]?.lines[0] === "B");
	await command("/fixture-ui reopened"); const reopened = await event("dialog", message => message.title === "permission-reopened");
	assert.notEqual(reopened.id, stopped.id); answer(a, reopened.id, false);
	await event("notice", message => message.text === "answer-reopened:false"); await wait(() => !state.isStreaming);
	wire = []; await command("/fixture-clear-ui");
	await event("widgets", message => message.conversationId === a && message.widgets.length === 0);
	await event("statuses", message => message.conversationId === a && message.statuses.length === 0);
	await event("extension_title", message => message.conversationId === a && message.title === "");
	await wait(() => !state.isStreaming);
	await command("/fixture-ui reloading"); const beforeReload = await event("dialog", message => message.title === "permission-reloading");
	await wait(() => !state.isStreaming);
	const sessionId = state.sessionId; wire = []; send({ type: "extensions_reload" });
	await event("dialog_closed", message => message.id === beforeReload.id);
	await event("settings_state"); send({ type: "get_state" }); await event("snapshot", message => message.state.sessionId === sessionId);
	answer(a, beforeReload.id, true); await sleep(100);
	assert(!wire.some(message => message.type === "notice" && message.text === "answer-reloading:true"));
	await command("/fixture-ui reloaded"); const afterReload = await event("dialog", message => message.title === "permission-reloaded");
	assert.notEqual(afterReload.id, beforeReload.id); answer(a, afterReload.id, false);
	await event("notice", message => message.text === "answer-reloaded:false"); await wait(() => !state.isStreaming);
	wire = []; await command("/fixture-ask");
	const ask = await event("dialog", message => message.kind === "ask");
	assert.equal(ask.questions.length, 3); assert.equal(ask.questions[0].options[0].preview, "<safe-preview>");
	const answers = [{ id: "single", selectedOptions: ["Detailed"] }, { id: "multi", selectedOptions: ["Search", "Preview"], customInput: "extra" }, { id: "text", selectedOptions: [], customInput: "notes" }];
	answer(a, ask.id, [...answers].reverse()); await sleep(100);
	assert(!wire.some(message => message.type === "dialog_closed" && message.id === ask.id));
	ws.terminate(); await connect();
	assert.equal((await event("dialog", message => message.kind === "ask")).id, ask.id);
	answer(a, ask.id, answers);
	const submitted = JSON.parse((await event("notice", message => message.text.startsWith("ask-result:"))).text.slice(11));
	assert.equal(submitted.kind, "submit");
	assert.deepEqual(submitted.results.map(({ id, selectedOptions, customInput }) => ({ id, selectedOptions, ...(customInput ? { customInput } : {}) })), answers);
	await wait(() => !state.isStreaming);
	wire = []; await command("/fixture-ask");
	const cancelledAsk = await event("dialog", message => message.kind === "ask");
	answer(a, cancelledAsk.id, null);
	await event("notice", message => message.text === "ask-result:undefined"); await wait(() => !state.isStreaming);
	wire = []; await command("/fixture-ask timeout");
	const timeoutAsk = await event("dialog", message => message.kind === "ask");
	assert.equal(timeoutAsk.timeoutMs, 500);
	await event("dialog_closed", message => message.id === timeoutAsk.id);
	const timeoutResult = JSON.parse((await event("notice", message => message.text.startsWith("ask-result:"))).text.slice(11));
	assert.deepEqual(timeoutResult.results.map(answer => answer.selectedOptions), [["Simple"], ["Preview"], []], "native timeout owns recommended answers");
	await wait(() => !state.isStreaming);

	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core"), { CHROME_PATH } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
		const page = await browser.newPage(); page.setDefaultTimeout(30000);
		const errors = []; page.on("pageerror", error => errors.push(error.message));
		await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "native-ui"));
		await page.goto(`http://127.0.0.1:${harness.port}`);
		await page.locator(".conn-dot.ok").first().waitFor({ state: "attached" });
		wire = []; await command("/fixture-details");
		const detailsPanel = page.locator('[data-dialog-kind="select"]');
		await detailsPanel.getByText("Long description", {exact:true}).waitFor();
		await detailsPanel.getByRole("button", {name:"Verbose",exact:true}).click();
		await event("notice", message => message.text === "details:Verbose"); await wait(() => !state.isStreaming);
		await command("/fixture-secret");
		const secretPanel = page.locator('[data-dialog-kind="input"]');
		await secretPanel.locator('input[type="password"]').fill("fixture-secret-value");
		await secretPanel.locator(".primary").click(); await event("notice", message => message.text === "secret:true"); await wait(() => !state.isStreaming);

		await command("/fixture-editor");
		const editor = page.locator('[data-dialog-kind="editor"]'); await editor.waitFor();
		assert.equal(await editor.locator("textarea").inputValue(), "first\nsecond");
		await editor.locator("textarea").fill("browser edited\nmultiline"); await editor.locator(".primary").click();
		await page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value === "browser edited\nmultiline");
		await wait(() => !state.isStreaming);
		await command("/fixture-ui browser"); const browserDialog = await event("dialog", message => message.title === "permission-browser");
		await page.locator('[data-dialog-kind="confirm"]').waitFor();
		await page.waitForFunction(() => document.title === "title-browser");
		await wait(() => !state.isStreaming); send({ type: "switch_conversation", id: b });
		await page.locator('[data-dialog-kind="confirm"]').waitFor({ state: "detached" });
		await page.waitForFunction(() => document.title === "title-B");
		await page.getByRole("button", { name: /permission-browser/ }).click();
		await page.locator('[data-dialog-kind="confirm"]').waitFor(); await wait(() => state.conversationId === a);
		await page.reload(); await page.locator('[data-dialog-kind="confirm"]').waitFor();
		await page.waitForFunction(() => document.title === "title-browser");
		send({ type: "abort" }); await event("dialog_closed", message => message.id === browserDialog.id);
		await page.locator('[data-dialog-kind="confirm"]').waitFor({ state: "detached" });
		await page.waitForFunction(() => document.title === "pi-harness");
		wire = []; await command("/fixture-ask");
		const askPanel = page.locator('[data-dialog-kind="ask"]'); await askPanel.waitFor();
		assert.equal(await askPanel.locator("fieldset").count(), 3);
		assert.equal(await askPanel.locator("input:checked").count(), 0, "recommendations do not submit or preselect answers");
		assert.equal(await askPanel.locator(".dialog-ask-preview").textContent(), "<safe-preview>");
		await askPanel.getByRole("radio", { name: "Detailed", exact: true }).check();
		await askPanel.locator("fieldset").nth(0).locator("textarea").fill("Custom style");
		assert.equal(await askPanel.getByRole("radio", { name: "Detailed", exact: true }).isChecked(), false);
		await askPanel.getByRole("checkbox", { name: "Search", exact: true }).check();
		await askPanel.getByRole("checkbox", { name: /^Preview/ }).check();
		await askPanel.locator("fieldset").nth(1).locator("textarea").fill("Extra feature");
		await askPanel.locator("fieldset").nth(2).locator("textarea").fill("Browser notes");
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await askPanel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
		await askPanel.locator(".primary").click(); await askPanel.waitFor({ state: "detached" });
		const browserResult = JSON.parse((await event("notice", message => message.text.startsWith("ask-result:"))).text.slice(11));
		assert.deepEqual(browserResult.results.map(({ selectedOptions, customInput }) => ({ selectedOptions, customInput })), [
			{ selectedOptions: [], customInput: "Custom style" }, { selectedOptions: ["Search", "Preview"], customInput: "Extra feature" }, { selectedOptions: [], customInput: "Browser notes" }
		]);
		await wait(() => !state.isStreaming);
		wire = []; await command("/fixture-ask"); await askPanel.waitFor();
		await page.reload(); await askPanel.waitFor();
		await askPanel.locator("textarea").first().focus(); await page.keyboard.press("Escape");
		await askPanel.waitFor({ state: "detached" });
		await event("notice", message => message.text === "ask-result:undefined"); await wait(() => !state.isStreaming);
		wire = []; await command("/fixture-ask"); await askPanel.waitFor();
		send({ type: "abort" }); await askPanel.waitFor({ state: "detached" }); await wait(() => !state.isStreaming);

		assert.deepEqual(errors, []);
		console.log("PASS browser extension UI: multiline editor draft, active/background dialog and title, navigation, refresh replay and Stop reset");
	}
	assert.equal(calls, 0, "UI commands never invoke a model");
	ws.terminate(); await connect({ clientId: "native-ui-wiki", wiki: true });
	await command("/fixture-ask");
	const wikiAsk = await event("dialog", message => message.kind === "ask");
	assert.equal(wikiAsk.conversationId, state.conversationId);
	answer(state.conversationId, wikiAsk.id, answers);
	await event("notice", message => message.text.startsWith("ask-result:") && message.conversationId === state.conversationId);
	await wait(() => !state.isStreaming);
	assert.equal(calls, 0, "Wiki ask dialog never invokes a model");
	console.log("PASS native extension UI: scoped widgets/status/title/notices, typed active-owner dialogs, select/editor/timeout, reconnect, Stop/reload cleanup, generation isolation and explicit reopen");
} finally {
	await browser?.close(); ws?.terminate(); await harness?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true });
}
