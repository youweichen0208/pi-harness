import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { startIsolatedHarness, listenIsolated } from "./lib/isolated-server.mjs";
const home = mkdtempSync(join(tmpdir(), "pi-model-sources-ws-"));
const put = (file, data) => { const path = join(home, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); return path; };
const requests = []; let pending;
const endpoint = createServer((req, res) => {
	let body = ""; req.on("data", b => body += b); req.on("end", () => {
		requests.push({ key: req.headers.authorization, body: JSON.parse(body) });
		const finish = () => { res.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const chunk of [{ choices: [{ index: 0, delta: { role: "assistant", content: "fixture reply" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "example", ...chunk })}\n\n`);
			res.end("data: [DONE]\n\n"); };
		if (requests.length === 1) pending = finish; else finish();
	});
});
let harness, ws, wiki, browser;
const messages = [];
async function wait(fn, label) { const deadline = Date.now() + 20000; while (Date.now() < deadline) { const result = fn(); if (result) return result; await delay(25); } throw Error(`Timeout: ${label}`); }
try {
	const port = await listenIsolated(endpoint);
	const config = key => ({ provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: key }, models: { example: { limit: { context: 32768, output: 4096 } }, broken: { options: { unsupported: true } } } } } });
	const source = put("opencode/opencode.json", config("FIRST_SECRET"));
	put("pi/settings.json", { defaultTools: { codemode: false } });
	harness = await startIsolatedHarness({ env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, "pi"), PI_WEB_DATA_DIR: join(home, "data"), PI_WEB_CWD: home,
		CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), OPENCODE_CONFIG: source, OPENCODE_CONFIG_DIR: join(home, "opencode"), XDG_DATA_HOME: join(home, "share") } });
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	ws.on("message", raw => messages.push(JSON.parse(raw)));
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	const send = data => ws.send(JSON.stringify(data));
	send({ type: "hello", clientId: "model-source-test", protocolVersion: 51 });
	await wait(() => messages.find(m => m.type === "ready"), "ready");
	send({ type: "list_models" }); send({ type: "list_models_config" });
	const model = await wait(() => messages.findLast(m => m.type === "models")?.models.find(m => m.provider.startsWith("sync-")), "imported model");
	const providers = await wait(() => messages.find(m => m.type === "models_config")?.providers, "source config");
	assert.equal(messages.find(m => m.type === "models_config").sources.find(s => s.source === "opencode").status, "partial");
	assert.equal(providers.length, 1); assert.equal(model.origin.sources[0], "opencode");
	const wikiMessages = [];
	wiki = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	wiki.on("message", raw => wikiMessages.push(JSON.parse(raw)));
	await new Promise((resolve, reject) => { wiki.once("open", resolve); wiki.once("error", reject); });
	wiki.send(JSON.stringify({ type: "hello", clientId: "wiki-model-source-test", protocolVersion: 51, wikiCwd: home }));
	await wait(() => wikiMessages.some(m => m.type === "ready"), "Wiki ready");
	wiki.send(JSON.stringify({ type: "list_models" }));
	const wikiModels = await wait(() => wikiMessages.findLast(m => m.type === "models")?.models, "Wiki models");
	assert(wikiModels.some(m => m.id === model.id));
	assert(messages.some(m => m.type === "snapshot" && m.state?.piConfigured) || messages.some(m => m.type === "snapshot" && m.piConfigured));
	send({ type: "set_model", modelId: model.id });
	send({ type: "prompt", text: "Reply fixture" });
	await wait(() => pending, "mock model request");
	assert.equal(requests[0].key, "Bearer FIRST_SECRET");
	assert.equal(providers[0].models[0].maxTokens, 16384);
	assert.equal(requests[0].body.max_tokens ?? requests[0].body.max_completion_tokens, 16384);
	writeFileSync(source, JSON.stringify(config("SECOND_SECRET")));
	send({ type: "sync_model_sources" }); await delay(300);
	pending();
	await wait(() => messages.some(m => (m.type === "snapshot" || m.type === "snapshot_delta") && (m.state?.messages ?? m.appended ?? []).some(x => JSON.stringify(x).includes("fixture reply"))), "reply");
	await delay(300);
	send({ type: "prompt", text: "Reply again" });
	await wait(() => requests.length === 2, "second request"); assert.equal(requests[1].key, "Bearer SECOND_SECRET");
	assert(!JSON.stringify(messages).includes("FIRST_SECRET")); assert(!JSON.stringify(messages).includes("SECOND_SECRET"));
	assert(!harness.logs.includes("FIRST_SECRET"));
	assert(!readFileSync(join(home, "data/model-sources.json"), "utf8").includes("SECOND_SECRET"));
	// Keep the original Pi identity while its equivalent external source survives.
	const nativeConfig = put("pi/models.json", { providers: { native: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "SECOND_SECRET", models: [{ id: "example", contextWindow: 32768, maxTokens: 16384, reasoning: false, input: ["text"] }] } } });
	await delay(300); send({ type: "sync_model_sources" });
	await wait(() => messages.findLast(m => m.type === "models")?.models.some(m => m.id === "native/example" && m.origin.sources.includes("opencode")), "native merged identity");
	send({ type: "set_model", modelId: "native/example" });
	await delay(300);
	rmSync(nativeConfig); send({ type: "sync_model_sources" });
	await wait(() => messages.findLast(m => m.type === "models")?.models.some(m => m.id === "native/example" && !m.origin.sources.includes("pi")), "native fallback identity");
	send({ type: "prompt", text: "Reply through preserved identity" });
	await wait(() => requests.length === 3, "native alias request");
	assert.equal(requests[2].key, "Bearer SECOND_SECRET");
	assert.equal(requests[2].body.model, "example");
	assert(!JSON.stringify(messages).includes("SECOND_SECRET"));
	assert(!harness.logs.includes("SECOND_SECRET"));
	assert(!readFileSync(join(home, "data/model-sources.json"), "utf8").includes("SECOND_SECRET"));
	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core");
		const { CHROME_PATH: executablePath } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath, headless: true });
		const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${harness.port}`);
		await page.waitForTimeout(1500);
		// Open via the model management button, using its localized accessible name.
		await page.locator(".chip-model:visible").first().click();
		await page.getByRole("button", { name: /管理模型|Manage models/i }).first().click();
		await page.getByRole("region", { name: /配置来源|Configuration sources/ }).waitFor();
		await page.getByText(/部分同步失败|Partially synced/).waitFor();
		await page.screenshot({ path: "tests/scratch/model-sources.png", fullPage: true, animations: "disabled" });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.screenshot({ path: "tests/scratch/model-sources-narrow.png", fullPage: true, animations: "disabled" });
	}
	console.log("PASS no-Pi external model, actual mock request, deferred rotation, native alias request and WS secret isolation");
} finally { await browser?.close(); ws?.close(); wiki?.close(); await harness?.stop(); endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve)); rmSync(home, { recursive: true, force: true }); }
