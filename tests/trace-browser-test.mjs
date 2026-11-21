import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { scrubHostEnv } from "./lib/test-env.mjs";

scrubHostEnv();
const root = mkdtempSync(join(tmpdir(), "pi-trace-browser-"));
const agent = join(root, "agent"), data = join(root, "data"), work = join(root, "work");
for (const directory of [agent, data, work]) mkdirSync(directory, { recursive: true });
writeFileSync(join(data, "design-first.json"), JSON.stringify({ enabled: false }));
let browser, harness, fixtureError;
const chunk = (res, delta, finishReason = null) => res.write(`data: ${JSON.stringify({ id: "trace-ui", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
const attack = `TRACE_DONE </pre><script>globalThis.__traceExportExecuted=true</script><iframe src="https://invalid.example"></iframe><meta http-equiv="refresh" content="0;url=https://invalid.example"><img src=x onerror=alert(1)><a href="javascript:alert(1)">click</a>`;
const escapedAttack = attack.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const model = createServer((req, res) => { void (async () => {
	let raw = ""; for await (const part of req) raw += part;
	const body = JSON.parse(raw);
	const text = body.messages.map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
	const hasToolResult = body.messages.some(message => message.role === "tool");
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.flushHeaders();
	if (text.includes("HOLD_TRACE")) {
		chunk(res, { role: "assistant", content: "Holding this run open." });
		await new Promise(resolve => req.once("close", resolve));
		return;
	}
	if (!hasToolResult) {
		chunk(res, { role: "assistant", content: "" });
		chunk(res, { tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "node -e \"setTimeout(() => process.exit(0), 50)\"" }) } }] });
		chunk(res, {}, "tool_calls");
	} else {
		chunk(res, { role: "assistant", content: attack });
		chunk(res, {}, "stop");
	}
	res.end("data: [DONE]\n\n");
})().catch(error => { fixtureError ??= error; res.destroy(error); }); });

async function restart(env = {}) {
	const port = harness?.port;
	await harness?.stop();
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: work, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent, ...env }, ...(port ? { nextPort: () => port } : {}) });
	return harness.port;
}
async function send(page, text) {
	const input = page.locator(".inputbox textarea");
	await input.fill(text);
	await page.locator(".composer-action.send").click();
}
async function openTrace(page) {
	await page.getByRole("button", { name: "执行 Trace", exact: true }).click();
	await page.locator(".trace-workbench").waitFor();
}
async function reload(page, port) {
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".inputbox textarea").waitFor();
	await page.waitForFunction(() => !document.querySelector(".inputbox textarea")?.disabled);
}

try {
	const modelPort = await listenIsolated(model);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "fixture", models: [{ id: "fixture", input: ["text"], contextWindow: 100000, maxTokens: 4096 }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
	const port = await restart();
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
	const errors = []; page.on("pageerror", error => errors.push(error.message));
	await reload(page, port);
	await send(page, "Run the trace tool fixture.");
	await page.locator(".msg-assistant").filter({ hasText: "TRACE_DONE" }).waitFor();
	await openTrace(page);
	await page.locator(".trace-run-list > button").waitFor();
	assert.equal(await page.locator(".trace-run-list > button").count(), 1);
	assert.equal(await page.locator(".trace-span-model").count(), 2);
	assert.equal(await page.locator(".trace-span-tool").count(), 1);
	assert(await page.locator(".trace-span-host").count() > 0);
	assert.match(await page.locator(".trace-aggregate-grid").innerText(), /总运行时间/);
	const htmlEvent = page.waitForEvent("download");
	await page.getByRole("button", { name: "导出会话与 Trace HTML", exact: true }).click();
	const htmlDownload = await htmlEvent;
	const htmlPath = await htmlDownload.path();
	const html = readFileSync(htmlPath, "utf8");
	assert(html.includes(escapedAttack));
	for (const raw of ["<script", "<iframe", "<img", "<meta http-equiv=\"refresh\"", 'href="javascript:']) assert(!html.includes(raw), `raw active markup: ${raw}`);
	assert(html.includes("Execution trace"));
	const exportedPath = join(root, "export-security.html");
	copyFileSync(htmlPath, exportedPath);
	const exported = await browser.newPage();
	const externalRequests = [], dialogs = [], exportErrors = [];
	exported.on("request", request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
	exported.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
	exported.on("pageerror", error => exportErrors.push(error.message));
	await exported.goto(pathToFileURL(exportedPath).href);
	const exportedText = await exported.locator("body").textContent();
	assert(exportedText.includes(attack), `escaped attack remains visible as inert text: ${JSON.stringify(exportedText.slice(0, 1200))}`);
	assert.equal(await exported.locator("script, iframe, img, meta[http-equiv=refresh], a[href]").count(), 0);
	assert.equal(await exported.evaluate(() => globalThis.__traceExportExecuted), undefined);
	assert.deepEqual(externalRequests, []); assert.deepEqual(dialogs, []); assert.deepEqual(exportErrors, []);
	await exported.close();
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	const jsonEvent = page.waitForEvent("download");
	await send(page, "/export json");
	const jsonDownload = await jsonEvent;
	await page.locator(".trace-workbench").waitFor();
	const metadata = JSON.parse(readFileSync(await jsonDownload.path(), "utf8"));
	assert.equal(metadata.privacy.containsMessageContent, false);
	assert.equal(metadata.privacy.anonymous, false);
	assert(!JSON.stringify(metadata).includes("TRACE_DONE"));
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await send(page, "/trace");
	await page.locator(".trace-workbench").waitFor();

	await restart();
	await reload(page, port);
	await openTrace(page);
	await page.locator(".trace-run-list > button").waitFor();
	assert.equal(await page.locator(".trace-run-list > button").count(), 1, "completed run survives a service restart");
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await send(page, "HOLD_TRACE");
	await page.locator(".msg-assistant").filter({ hasText: "Holding this run open." }).waitFor();
	const interrupted = new Promise(resolve => harness.child.once("close", resolve));
	harness.child.kill("SIGKILL");
	await interrupted;
	await restart();
	await reload(page, port);
	await openTrace(page);
	await page.locator(".trace-status.status-interrupted").first().waitFor();
	const filesBefore = readdirSync(join(data, "traces")).filter(name => name.endsWith(".jsonl")).length;
	await page.getByRole("button", { name: "关闭", exact: true }).click();

	await restart({ PI_TASK_TIMINGS: "off" });
	await reload(page, port);
	await send(page, "/new");
	await page.waitForFunction(() => { const input = document.querySelector(".inputbox textarea"); return input && !input.disabled && input.value === ""; });
	await send(page, "Run the trace tool fixture with collection disabled.");
	await page.locator(".msg-assistant").filter({ hasText: "TRACE_DONE" }).waitFor();
	await openTrace(page);
	await page.getByText("当前会话还没有 Trace。发送一条消息后会自动记录。", { exact: true }).waitFor();
	const filesAfter = readdirSync(join(data, "traces")).filter(name => name.endsWith(".jsonl")).length;
	assert.equal(filesAfter, filesBefore, "disabled collection creates no new trace file");
	assert.deepEqual(errors, []);
	assert.equal(fixtureError, undefined);
	console.log("PASS trace browser: real SDK/model/tool spans, topbar and slash commands, safe HTML/JSON downloads, restart/interrupted recovery, opt-out");
} catch (error) {
	console.error("Trace fixture error:", fixtureError, "Harness:", harness?.logs);
	throw error;
} finally {
	await browser?.close(); await harness?.stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
