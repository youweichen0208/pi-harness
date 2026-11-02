// User-facing directory recovery and accepted-elsewhere draft status, no model calls.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-error-status-"));
const cwd = join(root, "work"), next = join(root, "next"), agent = join(root, "agent");
for (const path of [cwd, next, agent]) mkdirSync(path);
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "unused", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 1024 }] } } }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "unused" } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
let harness, browser;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors = [], outgoing = [];
	page.on("pageerror", error => errors.push(error.message));
	let wire, upstream, state, holdPrompt = false, held;
	await page.routeWebSocket("**/ws", route => {
		wire = route; upstream = route.connectToServer();
		route.onMessage(raw => {
			const message = JSON.parse(String(raw)); outgoing.push(message);
			if (holdPrompt && message.type === "prompt") { held = message; return; }
			if (holdPrompt && message.type === "query_prompt_receipt") return;
			upstream.send(raw);
		});
		upstream.onMessage(raw => {
			const message = JSON.parse(String(raw));
			if (message.type === "snapshot") state = message.state;
			else if (message.type === "snapshot_delta" && state) state = { ...state, ...message.state, messages: [...state.messages, ...message.appended] };
			route.send(raw);
		});
	});
	await page.goto(`http://127.0.0.1:${harness.port}`);
	const input = page.locator(".inputbar textarea");
	await input.waitFor();
	await input.fill(`/cwd ${join(root, "missing")}`); await input.press("Enter");
	const toast = page.locator(".notice").filter({ hasText: "工作目录不存在，无法切换" });
	await toast.waitFor();
	assert.equal(await toast.locator("pre").isVisible(), false);
	await toast.getByText("查看技术详情", { exact: true }).click();
	assert.match(await toast.locator("pre").innerText(), /ENOENT/);
	await toast.getByText("查看技术详情", { exact: true }).click();
	await toast.getByRole("button", { name: "重新选择目录" }).click();
	const picker = page.getByRole("dialog", { name: "重新选择目录" });
	await picker.waitFor();
	const manual = picker.locator("input");
	await manual.fill(next);
	await picker.getByRole("button", { name: "重新选择目录", exact: true }).click();
	await page.waitForFunction(path => document.body.textContent.includes(path), next);
	assert(outgoing.some(message => message.type === "set_cwd" && message.path === next && message.source === "ui"));
	await picker.waitFor({ state: "detached" });
	await toast.waitFor({ state: "detached" });
	// Recreate the real error and then deliver an accepted receipt for an old session.
	upstream.send(JSON.stringify({ type: "set_cwd", path: join(root, "missing-again"), source: "ui" }));
	await toast.waitFor();
	holdPrompt = true;
	await input.fill("保留这份草稿"); await input.press("Enter");
	for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20));
	assert(held);
	wire.send(JSON.stringify({ type: "snapshot", state: { ...state, sessionId: "changed-native-session", rev: state.rev + 1 } }));
	await page.waitForTimeout(100);
	wire.send(JSON.stringify({ type: "prompt_result", requestId: held.requestId, conversationId: held.target.conversationId, ok: true, receipt: "accepted" }));
	const status = page.locator(".composer-receipt-status");
	await status.filter({ hasText: "此处内容已保存为草稿" }).waitFor();
	assert.match(await status.innerText(), /此处内容已保存为草稿/);
	assert.equal(await input.inputValue(), "保留这份草稿");
	assert.equal(outgoing.filter(message => message.type === "prompt" && message.text === "保留这份草稿").length, 1);
	mkdirSync("tests/scratch", { recursive: true });
	await page.screenshot({ path: "tests/scratch/error-status-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	const sendBox = await page.locator(".composer-action.send").boundingBox();
	assert(sendBox && sendBox.y + sendBox.height <= 844, "composer action stays within the narrow viewport");
	await page.screenshot({ path: "tests/scratch/error-status-mobile.png" });
	await status.waitFor({ state: "detached", timeout: 7000 });
	assert.equal(await input.inputValue(), "保留这份草稿");
	holdPrompt = false;
	await page.evaluate(() => { localStorage.setItem("pi-harness:lang", "en"); });
	await page.reload(); await input.waitFor();
	await page.evaluate(() => document.documentElement.setAttribute("data-appearance", "dark"));
	await input.fill(`/cwd ${join(root, "missing-english")}`); await input.press("Enter");
	const english = page.locator(".notice").filter({ hasText: "Working directory not found" });
	await english.waitFor();
	await english.getByText("View technical details", { exact: true }).click();
	assert.match(await english.locator("pre").innerText(), /missing-english/);
	assert.equal(await english.getByRole("button", { name: "Select another directory" }).isVisible(), true);
	await page.screenshot({ path: "tests/scratch/error-status-dark-en.png" });
	assert.deepEqual(errors, []);
	console.log("PASS directory error details, real folder reselection, accepted-elsewhere draft, dismissal and narrow layout");
} finally {
	await browser?.close(); await harness?.stop(); rmSync(root, { recursive: true, force: true });
}
