// Real extension sendUserMessage → SDK → serialization → optional browser.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { mergeSnapshot } from "./lib/snapshots.mjs";
import { PROTOCOL_VERSION } from "../dist/server/protocol-version.js";

const root = mkdtempSync(join(tmpdir(), "omp-delegate-notice-"));
const data = join(root, "data"), agent = join(data, "omp/agent"), cwd = join(root, "work");
const notification = "[acp_delegate FAILED ⚠️] **researcher** (runId `del_mvqe9kh7_2098`, exit ?) No delegates are currently running. This delegate did NOT complete its task — its result is missing from your work. Read the error excerpt (and the result file if present), then decide whether to re-dispatch the task before wrapping up. This is an automated system notification, NOT a user message.\n\nError excerpt: fixture process exited unexpectedly.";
const requests = [];
const model = createServer(async (req, res) => {
	let raw = ""; for await (const chunk of req) raw += chunk;
	requests.push(JSON.parse(raw));
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Delegate failure recorded." }, finish_reason: null }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
	res.end("data: [DONE]\n\n");
});
let harness, ws, browser, state, ready = false;
async function wait(check) {
	for (let i = 0; i < 600; i++) { if (check()) return; await sleep(25); }
	throw Error(`Fixture timed out: ${harness?.logs}`);
}
try {
	const modelPort = await listenIsolated(model);
	mkdirSync(join(agent, "extensions"), { recursive: true }); mkdirSync(cwd);
	writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: "fixture", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 1024 }] } } }));
	writeFileSync(join(agent, "config.yml"), JSON.stringify({ model: "fixture/fixture", skills: { enabled: false }, cacheWarming: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } }));
	writeFileSync(join(agent, "extensions/notify.ts"), `export default pi => pi.registerCommand("fixture-notice", { handler: async () => { pi.sendUserMessage(${JSON.stringify(notification)}); } });`);
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data } });
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	ws.on("message", raw => {
		const message = JSON.parse(raw);
		if (message.type === "ready") ready = true;
		state = mergeSnapshot(state, message);
	});
	await new Promise(resolve => ws.once("open", resolve));
	ws.send(JSON.stringify({ type: "hello", clientId: "delegate-notification", protocolVersion: PROTOCOL_VERSION }));
	await wait(() => ready && state && !state.tree?.verifying);
	ws.send(JSON.stringify({ type: "prompt", text: "/fixture-notice" }));
	await wait(() => state.messages.some(message => message.role === "assistant") && !state.isStreaming && requests.length);
	assert(state.messages.some(message => message.customType === "acp-delegate"), "OMP notification remains a user message instead of the existing notification card");
	const projected = state.messages.find(message => message.customType === "acp-delegate");
	assert.equal(projected.role, "custom");
	assert.equal(projected.content[0].text, notification);
	const nativeText = content => typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
	assert.equal(requests.length, 1, "displaying an extension notification cannot add a model call");
	const providerNotice = requests[0].messages.filter(message => message.role === "user").map(message => nativeText(message.content)).find(text => text.endsWith(notification));
	assert(providerNotice, "model input retains the complete original notification as a user message");
	const nativePrefix = providerNotice.slice(0, -notification.length);
	assert(nativePrefix === "" || /^<system-reminder>\n[\s\S]*<\/system-reminder>\n$/.test(nativePrefix), "only the native OMP environment reminder may precede the notification");
	const saved = readFileSync(state.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert(saved.some(entry => entry.message?.role === "user" && nativeText(entry.message.content) === notification), "UI projection cannot rewrite the native transcript");
	if (process.argv.includes("--browser")) {
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
		await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "delegate-notification"));
		ws.close();
		await page.goto(`http://127.0.0.1:${harness.port}`);
		const notice = page.locator(".delegate-notification");
		await notice.waitFor();
		assert.equal(await notice.getAttribute("open"), null);
		assert.match(await notice.locator("summary").innerText(), /researcher/);
		assert.equal(await notice.locator("pre").isVisible(), false);
		await notice.locator("summary").click();
		assert.equal(await notice.locator("pre").innerText(), notification);
		await page.setViewportSize({ width: 390, height: 800 });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
		mkdirSync("tests/scratch", { recursive: true });
		await page.screenshot({ path: "tests/scratch/delegate-notification-mobile.png" });
		await page.reload(); await notice.waitFor();
		await notice.locator("summary").focus(); await page.keyboard.press("Enter");
		assert.equal(await notice.locator("pre").isVisible(), true);
		await page.keyboard.press("Enter");
		assert.equal(await notice.getAttribute("open"), null);
	}
	assert.equal(requests.length, 1, "browser reconnect and disclosure do not invoke the model");
	console.log("PASS issue 137: native extension notification, intact model input, event projection" + (browser ? ", keyboard disclosure, narrow layout and reload" : ""));
} finally {
	await browser?.close(); ws?.close(); await harness?.stop();
	model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
