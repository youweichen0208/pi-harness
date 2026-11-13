import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
const root = mkdtempSync(join(tmpdir(), "pg-chat-"));
const agent = join(root, "agent"), data = join(root, "data");
mkdirSync(agent); mkdirSync(data);
writeFileSync(join(root, "AGENTS.md"), "PROJECT_SECRET_SENTINEL");
writeFileSync(join(agent, "APPEND_SYSTEM.md"), "GLOBAL_SECRET_SENTINEL");
const requests = [];
let hold = false, fail = false;
const mock = createServer(async (req, res) => {
	let text = ""; for await (const chunk of req) text += chunk;
	const body = JSON.parse(text); requests.push(body);
	if (fail) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "context window exceeded", type: "invalid_request_error" } })); return; }
	res.writeHead(200, { "content-type": "text/event-stream" });
	const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
	if (hold) { send({ role: "assistant", content: "partial" }); return; }
	if (requests.length === 1) {
		send({ role: "assistant", tool_calls: [{ index: 0, id: "proposal1", type: "function", function: { name: "propose_playground_code", arguments: JSON.stringify({ explanation: "Fix", code: "print(42)\n" }) } }] });
		send({}, "tool_calls");
	} else { send({ role: "assistant", content: "Reviewed" }); send({}, "stop"); }
	res.end("data: [DONE]\n\n");
});
const mockPort = await listenIsolated(mock);
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: "fixture", models: [{ id: "mock", name: "Mock", input: ["text"], contextWindow: 128000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "mock" }));
const env = { PI_WEB_CWD: root, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent, PI_WEB_PLAYGROUND: "off" };
let harness, ws, state, main, browser, events = [];
const wait = async fn => { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); } throw Error("Timed out " + JSON.stringify(events.slice(-3)) + harness.logs); };
async function connect() {
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	ws.on("message", data => { const m = JSON.parse(data); events.push(m); if (m.type === "playground_chat_state") state = m.state; if (m.type === "snapshot") main = m.state; });
	await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
	ws.send(JSON.stringify({ type: "hello", clientId: "pg-test" }));
	await wait(() => main);
}
const send = (action, extra = {}) => ws.send(JSON.stringify({ type: "playground_chat", action, requestId: crypto.randomUUID(), conversationId: state?.id, ...extra }));
try {
	harness = await startIsolatedHarness({ env }); await connect();
	send("open", { model: { provider: "fixture", id: "mock" } }); await wait(() => state);
	assert.equal(requests.length, 0);
	const id = state.id;
	const context = { code: "print('UNSAVED')", parameters: '{"function":"f","args":[7]}', output: "PARTIAL_FROZEN_OUTPUT", partial: true, stale: true, truncated: true, runVersion: "run-1" };
	const requestId = "same-request";
	send("send", { requestId, text: "Review", context });
	await wait(() => state.proposals.length === 1 && !state.running && requests.length === 2);
	assert.equal(state.proposals[0].base, context.code);
	assert.equal(state.proposals[0].code, "print(42)\n");
	const payload = JSON.stringify(requests[0]);
	assert(payload.includes("UNSAVED")); assert(payload.includes("PARTIAL_FROZEN_OUTPUT"));
	assert(!payload.includes("PROJECT_SECRET_SENTINEL")); assert(!payload.includes("GLOBAL_SECRET_SENTINEL"));
	assert.deepEqual(requests[0].tools.map(t => t.function.name), ["propose_playground_code"]);
	assert(!JSON.stringify(main.messages).includes("UNSAVED"));
	send("send", { requestId, text: "Review", context });
	await new Promise(r => setTimeout(r, 150)); assert.equal(requests.length, 2);
	send("new"); await wait(() => state.id !== id);
	send("switch", { targetId: id }); await wait(() => state.id === id && state.messages.length > 0);
	ws.close(); await harness.stop();
	state = undefined; main = undefined; events = [];
	harness = await startIsolatedHarness({ env }); await connect(); send("open"); await wait(() => state);
	assert.equal(state.id, id); assert.equal(state.proposals.length, 1);
	send("receipt", { requestId }); await wait(() => events.some(e => e.type === "playground_chat_result" && e.result.ok));
	assert.equal(requests.length, 2);

	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core");
		const { CHROME_PATH } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		const errors = []; page.on("pageerror", error => errors.push(error.message));
		await fetch(`http://127.0.0.1:${harness.port}/api/playground/scratch`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: context.code, expectedVersion: 0 }) });
		await page.goto(`http://127.0.0.1:${harness.port}`);
		await page.getByRole("button", { name: "Playground", exact: true }).click();
		await page.locator(".scratch-head").getByRole("button", { name: "问 pi", exact: true }).click();
		await page.locator("#pg-chat-input").fill("preserved draft");
		await page.getByRole("tab", { name: "参数", exact: true }).click();
		await page.getByRole("tab", { name: "问 pi", exact: true }).click();
		assert.equal(await page.locator("#pg-chat-input").inputValue(), "preserved draft");
		const apply = page.getByRole("button", { name: "应用修改", exact: true });
		const editor = page.locator(".scratch-editor-cm .cm-content");
		await editor.click(); await page.keyboard.press("End"); await page.keyboard.type(" # changed");
		await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(b => b.textContent === "应用修改" && b.disabled));
		await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
		await apply.click();
		await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("print(42)"));
		await editor.click(); await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
		await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("UNSAVED"));
		await page.setViewportSize({ width: 600, height: 900 });
		assert(await editor.isVisible());
		await page.evaluate(() => { document.documentElement.dataset.appearance = "dark"; window.dispatchEvent(new Event("pi:theme-change")); });
		await page.waitForFunction(() => document.querySelector(".scratch-save-status")?.textContent.includes("已保存"));
		const scratchUrl = `http://127.0.0.1:${harness.port}/api/playground/scratch`;
		const stored = await (await fetch(scratchUrl)).json();
		assert.equal((await fetch(scratchUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "print('other tab')", expectedVersion: stored.updatedAt }) })).status, 200);
		await editor.click(); await page.keyboard.press("End"); await page.keyboard.type(" # local");
		await page.getByRole("button", { name: "重新加载草稿" }).waitFor();
		assert((await editor.textContent()).includes("local"));
		await page.getByRole("button", { name: "重新加载草稿" }).click();
		await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("other tab"));
		await page.screenshot({ path: "/tmp/playground-chat-dark-narrow.png", fullPage: true });
		fail = true;
		await page.locator("#pg-chat-input").fill("keep this question on context failure");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await wait(() => !!state.error);
		await page.waitForFunction(() => document.querySelector("#pg-chat-input")?.value === "keep this question on context failure");
		fail = false;
		assert.deepEqual(errors, []);
		await browser.close(); browser = undefined;
	}
	const beforeRun = requests.length;
	hold = true; send("send", { text: "Wait", context }); await wait(() => requests.length === beforeRun + 1);
	send("stop"); await wait(() => !state.running);
	send("send", { text: "Interrupt on restart", context }); await wait(() => requests.length === beforeRun + 2);
	ws.close(); harness.child.kill("SIGKILL"); await harness.stop();
	state = undefined; main = undefined;
	harness = await startIsolatedHarness({ env }); await connect(); send("open"); await wait(() => state);
	assert.equal(state.interrupted, true); assert.equal(requests.length, beforeRun + 2);
	console.log("PASS Playground chat: isolated tools/context, frozen source, proposals, deduplication, history/restart and stop");
} finally {
	await browser?.close(); ws?.close(); await harness?.stop(); mock.closeAllConnections(); await new Promise(r => mock.close(r)); rmSync(root, { recursive: true, force: true });
}
