/** #143: real SDK + local model fixture; no paid model or user data. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-output-limit-"));
const agent = join(root, "agent"), data = join(root, "data"), cwd = join(root, "work");
for (const dir of [agent, data, cwd]) mkdirSync(dir);
writeFileSync(join(cwd, "note.txt"), "Fixture input");
for (const name of ["plan-settings", "subagents"]) writeFileSync(join(data, `${name}.json`), JSON.stringify({ enabled: false }));
let requests = 0, mode = "thinking", toolReturned = false;
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body);
	requests++;
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 4096, total_tokens: 4116 } } : {}) })}\n\n`);
	if (!toolReturned && mode !== "complete") {
		toolReturned = true;
		chunk({ tool_calls: [{ index: 0, id: `read-${requests}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "note.txt" }) } }] });
		chunk({}, "tool_calls");
	} else {
		if (mode !== "empty") chunk({ reasoning_content: "Thinking through the report." });
		if (mode === "partial" || mode === "complete") chunk({ content: mode === "partial" ? "Partial report preserved." : "Finished report." });
		chunk({}, mode === "complete" ? "stop" : "length");
	}
	res.end("data: [DONE]\n\n");
});
let harness, browser;
try {
	const port = await listenIsolated(mock);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}`, apiKey: "fixture", models: [{ id: "fixture", name: "Fixture", reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 4096 }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultTools: ["read"], retry: { enabled: false }, compaction: { enabled: false } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent } });
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	for (const locale of ["zh", "en"]) {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.addInitScript(lang => localStorage.setItem("pi-harness:lang", lang), locale);
		const errors = [];
		page.on("pageerror", error => errors.push(error.message));
		let state;
		await page.routeWebSocket("**/ws", route => {
			const upstream = route.connectToServer();
			upstream.onMessage(wire => {
				const message = JSON.parse(String(wire));
				if (message.type === "snapshot") state = message.state;
				if (message.type === "snapshot_delta" && state) state = { ...message.state, messages: [...state.messages, ...message.appended] };
				route.send(wire);
			});
		});
		await page.goto(`http://127.0.0.1:${harness.port}`);
		const input = page.locator(".inputbox textarea");
		const ready = async () => {
			await page.waitForFunction(() => !document.querySelector(".inputbox textarea")?.disabled);
		};
		await ready();
		for (const scenario of ["thinking", "empty", "partial"]) {
			mode = scenario; toolReturned = false;
			const before = requests;
			await input.fill(`Write ${scenario} report ${locale}`);
			await input.press("Enter");
			const action = page.getByRole("button", { name: locale === "zh" ? "调整输出额度" : "Adjust output limit", exact: true });
			const continueAction = page.getByRole("button", { name: locale === "zh" ? "准备继续" : "Prepare to continue", exact: true });
			await action.waitFor();
			await page.waitForTimeout(200);
			assert.equal(requests, before + 2, "only explicit request and native tool-result round; no auto continuation");
			assert.equal(state.isStreaming, false);
			assert.equal(state.taskProgress.status, "failed");
			const last = state.messages.findLast(message => message.role === "assistant");
			assert.equal(last.stopReason, "length");
			if (scenario !== "empty") assert(last.content.some(block => block.type === "thinking"));
			await page.getByRole("tab", { name: locale === "zh" ? "任务" : "Tasks", exact: true }).click();
			await page.getByText(locale === "zh" ? "输出达到上限 · 回答未完成" : "Output limit reached · Answer incomplete", { exact: true }).waitFor();
			if (scenario === "partial") await page.getByText("Partial report preserved.", { exact: true }).last().waitFor();
			assert.equal(state.taskProgress.steps[0].status, "done", "completed read remains successful");
			await input.fill("Keep my draft");
			await action.click();
			await page.locator(".modal-backdrop").waitFor();
			await page.locator(".modal-backdrop").click({ position: { x: 2, y: 2 } });
			assert.equal(await input.inputValue(), "Keep my draft", "settings preserves the draft");
			if (scenario === "partial") {
				await continueAction.click();
				assert((await input.inputValue()).startsWith("Keep my draft\n\n"));
			} else {
				assert.equal(await continueAction.count(), 0, "no blind continue when no answer was generated");
				assert.match(await page.locator(".reply-output-limit").last().innerText(), locale === "zh" ? /仅发送「继续」可能再次截断/ : /may hit the same limit again/);
			}
			assert.equal(requests, before + 2, "preparing continuation only edits the draft");
			await input.fill("");
			await page.reload();
			await action.waitFor();
			assert.equal(state.taskProgress.status, "failed", "reload preserves truncation outcome");
			if (scenario === "partial") {
				mkdirSync("tests/scratch", { recursive: true });
				await page.screenshot({ path: `tests/scratch/output-limit-${locale}.png` });
			}
		}
		mode = "complete";
		await page.getByRole("button", { name: locale === "zh" ? "准备继续" : "Prepare to continue", exact: true }).click();
		await input.press("Enter");
		await page.getByText("Finished report.", { exact: true }).waitFor();
		await page.waitForTimeout(200);
		assert.equal(await page.getByRole("button", { name: locale === "zh" ? "准备继续" : "Prepare to continue", exact: true }).count(), 0, "old messages cannot continue the wrong turn");
		assert.deepEqual(errors, []);
		console.log(`PASS ${locale}: thinking-only and partial limits, failed task, preserved tools, draft, reload, manual continuation`);
		await context.close();
	}
} finally {
	await browser?.close();
	await harness?.stop();
	mock.closeAllConnections();
	await new Promise(resolve => mock.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
