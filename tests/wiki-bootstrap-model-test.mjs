/** Real SDK, isolated workspace and local model: Wiki mode contracts (ADR-0003 独立窗口). */
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { testEnv } from "./lib/test-env.mjs";

const port = 9290;
assert.equal(await portUp(port), false, "isolated port must be free");
assert.equal(await portUp(port + 1), false);
const base = realpathSync(mkdtempSync(join(tmpdir(), "doc-evidence-")));
const cwd = join(base, "workspace"), agent = join(base, "agent");
mkdirSync(agent); mkdirSync(join(cwd, "knowledge/evidence/source"), { recursive: true });
writeFileSync(join(cwd, "README.md"), "# Knowledge entry\n\nSelected exact passage.\n\n[Other](./other.md)\n\n" + Array.from({length: 80}, (_, i) => `Paragraph ${i}.\n\n`).join(""));
writeFileSync(join(cwd, "knowledge/manifest.json"), JSON.stringify({ kind: "pi-harness-knowledge", version: 1, evidenceDirectory: "evidence" }));
const rawPath = join(cwd, "knowledge/evidence/source/original.md"), raw = "# Archived evidence\n\n原始文件内容应保持不变。\n";
writeFileSync(rawPath, raw);
writeFileSync(join(cwd, "background.ts"), "export const background = true;\n");
writeFileSync(join(cwd, "other.md"), "# Other document\n\nOther text.\n");
let releaseReply;
let responseGate = new Promise(resolve => { releaseReply = resolve; });
const mock = createServer(async (req, res) => {
	for await (const chunk of req) {}
	res.writeHead(200, { "content-type": "text/event-stream" });
	await responseGate;
	for (const [delta, finish_reason] of [[{role: "assistant", content: Array.from({length: 50}, (_, i) => `Reply paragraph ${i}.\n\n`).join("")}, null], [{}, "stop"]]) res.write(`data: ${JSON.stringify({id: "local", object: "chat.completion.chunk", choices: [{index: 0, delta, finish_reason}]})}\n\n`);
	res.end("data: [DONE]\n\n");
});
await new Promise(r => mock.listen(port + 1, "127.0.0.1", r));
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port + 1}`, apiKey: "unused", models: ["unused", "alternate"].map(id => ({ id, name: id, input: ["text"], contextWindow: 32000, maxTokens: 4096 })) } } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "unused" }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "unused" } }));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: "", PI_WEB_HOST: "127.0.0.1", PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
let log = "", browser;
const errors = [];
server.stdout.on("data", data => { log += data; }); server.stderr.on("data", data => { log += data; });
try {
	for (let i = 0; i < 150 && !await portUp(port); i++) {
		assert.equal(server.exitCode, null, log);
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
	assert.equal(health.pid, server.pid);
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	// #113: native controls must occupy space beside, not over, Wiki tools.
	for (const platform of ["win32", "linux"]) {
		const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
		await page.addInitScript(platform => { window.windowActions = []; window.electronAPI = { platform, windowAction(action) { window.windowActions.push(action); }, onWindowState() { return () => {}; } }; }, platform);
		await page.goto(`http://127.0.0.1:${port}/?${new URLSearchParams({ "wiki-window": "1", cwd, doc: "README.md", client: `controls-${platform}` })}`);
		await page.locator(".wiki-prose .fp-rich-document").waitFor();
		for (const width of [1100, 900, 720]) {
			await page.setViewportSize({ width, height: 800 });
			const controls = await page.locator(".wiki-window-header .desktop-window-controls").boundingBox();
			const ask = await page.locator(".wiki-ask-toggle").boundingBox();
			assert(controls.x + controls.width <= width, "window controls stay inside the viewport");
			assert(controls.x >= ask.x + ask.width, `${platform}/${width}: native controls overlap Wiki tools`);
			for (const button of await page.locator(".wiki-window-header .desktop-window-controls button").all()) {
				assert(await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), "window control is reachable");
				await button.click();
			}
			mkdirSync("tests/scratch", { recursive: true });
			await page.locator(".wiki-window-header").screenshot({ path: `tests/scratch/wiki-controls-${platform}-${width}.png` });
		}
		assert.deepEqual(await page.evaluate(() => window.windowActions), Array(3).fill(["minimize", "toggle-maximize", "close"]).flat());
		await page.close();
	}
	// #114: while the SDK is starting, never render ordinary chat.
	{
		const page = await browser.newPage();
		let releaseHello;
		await page.routeWebSocket("**/ws", route => {
			const upstream = route.connectToServer();
			route.onMessage(wire => { if (JSON.parse(String(wire)).type === "hello") releaseHello = () => upstream.send(wire); else upstream.send(wire); });
			upstream.onMessage(wire => route.send(wire));
		});
		await page.goto(`http://127.0.0.1:${port}/?${new URLSearchParams({ "wiki-window": "1", cwd, doc: "README.md", client: "slow-start" })}`);
		await page.locator(".wiki-window-shell").waitFor({ timeout: 1500 });
		assert.equal(await page.locator(".topbar").count(), 0);
		releaseHello();
		await page.locator(".wiki-prose .fp-rich-document").waitFor();
		await page.close();
	}
	for (const [model, stalled] of [["glm-5.3", false], ["fixture/alternate", false], ["missing/model", false], ["fixture/alternate", true]]) {
		console.log("Checking carry", model);
		const page = await browser.newPage();
		let latest, modelRequests = 0;
		await page.routeWebSocket("**/ws", route => {
			const upstream = route.connectToServer();
			route.onMessage(wire => {
				if (JSON.parse(String(wire)).type === "set_model") { modelRequests++; if (stalled) return; }
				upstream.send(wire);
			});
			upstream.onMessage(wire => { const message = JSON.parse(String(wire)); if (message.type === "snapshot" || message.type === "snapshot_delta") latest = message.state; route.send(wire); });
		});
		const params = new URLSearchParams({ "wiki-window": "1", cwd, doc: "README.md", client: `carry-${model.replaceAll("/", "-")}-${stalled}`, model, thinking: "off" });
		await page.goto(`http://127.0.0.1:${port}/?${params}`);
		try { await page.locator(".wiki-prose .fp-rich-document").waitFor({ timeout: 10000 }); } catch (error) { console.log((await page.locator("body").innerText()).slice(0, 2500)); throw error; }
		assert.equal(await page.locator(".topbar").count(), 0, "Wiki must not remain in ordinary chat");
		assert.equal(latest.wiki, true);
		assert.equal(latest.conversationId, "c1", "initial Wiki reuses its first runtime");
		assert(modelRequests <= 1, "inheritance must not retry indefinitely");
		if (model === "fixture/alternate" && !stalled) assert.equal(latest.model.id, "alternate");
		await page.close();
	}
	console.log("PASS Wiki bootstrap with legacy, qualified and unavailable models");
} finally {
	releaseReply();
	await browser?.close();
	await new Promise(r => mock.close(r));
	if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, "exit"); server.kill(); await stopped; }
	rmSync(base, { recursive: true, force: true });
}
