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
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:" + port, apiKey: "test", models: [{ id: "mock", name: "Mock", input: ["text"], contextWindow: 128000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "mock" }));
let harness, browser;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent } });
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
	const errors = []; page.on("pageerror", e => errors.push(e.message));
	await page.goto("http://127.0.0.1:" + harness.port);
	const input = page.locator(".inputbox textarea");
	await input.fill("Show a Python example"); await input.press("Enter");
	await page.getByRole("button", { name: "运行此代码块", exact: true }).click();
	await page.getByRole("button", { name: "请 pi 修复", exact: true }).waitFor();
	assert.equal(calls, 1);
	await input.fill("已有草稿");
	await page.getByRole("button", { name: "请 pi 修复", exact: true }).click();
	await page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value.includes("NameError"));
	const draft = await input.inputValue();
	assert(draft.includes("已有草稿"));
	assert(draft.includes("stack.append(x)"));
	assert(draft.includes("NameError"));
	assert(draft.includes("不要自动执行"));
	assert.equal(calls, 1, "repair only fills composer");
	await page.getByText("运行范围与说明", { exact: true }).click();
	assert(await page.getByText("只运行此代码块，不继承其他代码块的变量。代码未经预先验证，可能需要补齐变量、导入或依赖。", { exact: true }).isVisible());
	assert.deepEqual(errors, []);
	console.log("PASS code-block repair: real NameError, source/output in preserved draft, no automatic model call");
} finally {
	await browser?.close(); await harness?.stop(); mock.closeAllConnections(); await new Promise(r => mock.close(r)); rmSync(root, { recursive: true, force: true });
}
