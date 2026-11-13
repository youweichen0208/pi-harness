import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
const root = mkdtempSync(join(tmpdir(), "pg-repair-")), agent = join(root, "agent");
mkdirSync(agent);
let calls = 0;
const code = "stack = []\nstack.append(x)\n";
const mock = createServer(async (req, res) => {
	for await (const _ of req) { /* Drain request. */ }
	calls++;
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "```python\n" + code + "```" }, finish_reason: null }] }) + "\n\n");
	res.end("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
});
const port = await listenIsolated(mock);
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:" + port, apiKey: "test", models: Array.from({ length: 12 }, (_, i) => ({ id: i ? "mock-" + i : "mock", name: "Model " + String(i + 1).padStart(2, "0"), input: ["text"], contextWindow: 128000, maxTokens: 4096 })) } } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "mock" }));
let harness, browser;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent } });
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
	const errors = []; page.on("pageerror", e => errors.push(e.message));
	await page.goto("http://127.0.0.1:" + harness.port);

	await page.locator(".input-tools .dropdown").filter({ has: page.locator(".chip-model") }).getByRole("button").first().click();
	const menu = page.locator(".dd-menu-model");
	await menu.getByText("Model 12", { exact: true }).waitFor();
	assert.equal(await menu.locator(".dd-item").count(), 12);
	assert.equal(await menu.locator(".model-count").innerText(), "12");
	assert.equal(await menu.getByText("登录账号", { exact: true }).count(), 0);
	assert.equal(await menu.locator(".model-account-entry").count(), 2);
	assert.equal(await menu.getByText("ChatGPT", { exact: true }).count(), 1);
	assert.equal(await menu.getByText("Kimi", { exact: true }).count(), 1);
	assert.equal(await menu.locator(".model-run-settings").getAttribute("open"), null);
	const visibleRows = await menu.locator(".dd-model-scroll").evaluate(el => {
		const bounds = el.getBoundingClientRect();
		return [...el.querySelectorAll(".dd-item")].filter(item => { const r = item.getBoundingClientRect(); return r.top >= bounds.top && r.bottom <= bounds.bottom; }).length;
	});
	assert(visibleRows >= 4, "show multiple models before scrolling");
	await menu.getByRole("textbox").fill("Model 12");
	assert.equal(await menu.locator(".dd-item").count(), 1);
	await menu.getByRole("textbox").fill("");
	await menu.locator("summary").click();
	assert(await menu.getByLabel("缓存预热 · 全局").isVisible());
	await menu.locator("summary").click();
	await page.screenshot({ path: "/tmp/model-menu-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	const bounds = await menu.boundingBox();
	assert(bounds.y >= 0 && bounds.height > 200);
	await page.evaluate(() => { document.documentElement.dataset.appearance = "dark"; });
	await menu.getByRole("textbox").focus();
	assert.equal(await menu.getByRole("textbox").evaluate(el => getComputedStyle(el).outlineStyle), "none");
	await page.screenshot({ path: "/tmp/model-menu-mobile-dark.png" });
	assert.deepEqual(errors, []);
	assert.equal(calls, 0);
	console.log("PASS model menu: 12 models, list space, filtering, collapsed settings, narrow/dark and one focus ring");

} finally {
	await browser?.close(); await harness?.stop(); mock.closeAllConnections(); await new Promise(r => mock.close(r)); rmSync(root, { recursive: true, force: true });
}
