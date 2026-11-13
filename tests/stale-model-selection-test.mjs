import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "stale-model-"));
const agent = join(root, "agent");
mkdirSync(agent);
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:19999", apiKey: "test", models: [{ id: "working", name: "Working model", input: ["text"], contextWindow: 128000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-5-5" }));

let harness, browser;
try {
	harness = await startIsolatedHarness({ env: {
		PI_WEB_CWD: root,
		PI_WEB_DATA_DIR: join(root, "data"),
		PI_CODING_AGENT_DIR: agent,
		ANTHROPIC_API_KEY: "test",
		ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/apps/anthropic",
	} });
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${harness.port}`);
	const picker = page.locator(".input-tools .chip-model-unavailable");
	await picker.waitFor();
	assert.match(await picker.innerText(), /Claude Opus/i);
	assert(await page.locator(".composer-model-warning").isVisible());
	const input = page.locator(".inputbox textarea").first();
	await input.fill("keep this draft");
	assert(await page.locator(".composer-action.send").first().isDisabled());
	await input.press("Enter");
	assert.equal(await input.inputValue(), "keep this draft");
	await picker.click();
	await page.locator(".dd-menu-model .dd-item").filter({ hasText: "Working model" }).click();
	await picker.waitFor({ state: "detached" });
	assert(await page.locator(".composer-action.send").first().isEnabled());
	assert.equal(await page.evaluate(() => localStorage.getItem("pi-preferred-chat-model")), "fixture/working");
	assert.deepEqual(errors, []);
	console.log("PASS stale model: visible warning, send blocked, draft retained, switch restores send");
} finally {
	await browser?.close();
	await harness?.stop();
	rmSync(root, { recursive: true, force: true });
}
