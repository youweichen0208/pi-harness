// Real Electron, local streaming model, isolated data. Run after npm run build.
// Desktop-only regression: chat links must not navigate the Wiki renderer to /file.md.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { _electron as electron } from "playwright-core";
import { portUp } from "./lib/port-utils.mjs";

const port = 9297;
assert.equal(await portUp(port), false, "local model port must be free");
const base = mkdtempSync(join(tmpdir(), "wiki-chat-links-"));
const cwd = join(base, "work"), agent = join(base, "agent");
const second = join(base, "second"), empty = join(base, "empty");
mkdirSync(second); mkdirSync(empty);
writeFileSync(join(second, "README.md"), "# Second workspace\n\nOther folder content.\n");
mkdirSync(cwd); mkdirSync(agent);
writeFileSync(join(cwd, "README.md"), "# Starting document\n\nOriginal content.\n");
writeFileSync(join(cwd, "other.md"), "# Other document\n\nTarget content.\n");
writeFileSync(join(agent, "auth.json"), JSON.stringify({ local: { type: "api_key", key: "unused" } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "unused" }));
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { local: {
	api: "openai-completions", baseUrl: `http://127.0.0.1:${port}`, apiKey: "unused",
	models: [{ id: "unused", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
} } }));

const replies = [];
const mock = createServer(async (req, res) => {
	for await (const chunk of req) { /* Drain the local prompt. */ }
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
		id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
	})}\n\n`);
	const target = replies.length === 0 ? "other.md" : "README.md";
	replies.push({
		append: text => emit({ content: text }),
		finish: () => { emit({}, "stop"); res.end("data: [DONE]\n\n"); },
	});
	// No blank line yet: the link starts in the active streaming tail.
	emit({ role: "assistant", content: `[Open document](${target})` });
});
let app, wiki;
const errors = [];
try {
	await new Promise((resolve, reject) => { mock.once("error", reject); mock.listen(port, "127.0.0.1", resolve); });
	app = await electron.launch({ args: [".", `--user-data-dir=${join(base, "profile")}`], env: {
		...process.env, PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: agent,
	} });
	// Record external opens instead of launching the user's real browser.
	await app.evaluate(({ shell, BrowserWindow }) => {
		globalThis.wikiLinkExternal = [];
		shell.openExternal = async url => { globalThis.wikiLinkExternal.push(url); };
		for (const window of BrowserWindow.getAllWindows()) window.setSize(1440, 1000);
	});
	let main;
	for (let i = 0; i < 200; i++) {
		main = app.windows().find(page => page.url().startsWith("http://127.0.0.1:"));
		if (main) break;
		await sleep(100);
	}
	assert(main, "main window ready");
	main.setDefaultTimeout(10000);
	await main.locator(".conn-dot.ok").first().waitFor({ state: "attached" });
	await main.locator(".file-name", { hasText: "README.md" }).click();
	for (let i = 0; i < 100; i++) {
		wiki = app.windows().find(page => page.url().includes("wiki-window=1"));
		if (wiki) break;
		await sleep(100);
	}
	assert(wiki, "main-window Markdown opens a detached Wiki window");
	wiki.setDefaultTimeout(10000);
	wiki.on("pageerror", error => errors.push(error.message));
	const editor = wiki.locator(".wiki-prose .fp-rich-document");
	await editor.waitFor();

	if (process.argv.includes("--fullscreen")) await app.evaluate(async ({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("wiki-window=1"));
		await new Promise(resolve => { win.once("enter-full-screen", resolve); win.setFullScreen(true); });
	});
	await wiki.locator(".wiki-ask-toggle").click();
	let floating;
	for (let i = 0; i < 100; i++) {
		floating = app.windows().find(page => page.url() === "about:blank");
		if (floating) break;
		await sleep(100);
	}
	assert(floating, "assistant opens a native window");
	await floating.locator(".wiki-assistant").waitFor();
	const bounds = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === "about:blank"); return { ...w.getBounds(), fullscreen: w.isFullScreen() }; });
	assert(!bounds.fullscreen && bounds.width < 700, `assistant must open as a compact window: ${JSON.stringify(bounds)}`);
	await floating.locator(".inputbar textarea").fill("Keep this draft across windows");
	await floating.getByRole("button", { name: "收起对话面板", exact: true }).click();
	await wiki.locator(".wiki-ask-toggle[aria-expanded=false]").waitFor();
	const afterCollapse = await app.evaluate(({ BrowserWindow }) => {
		const windows = BrowserWindow.getAllWindows();
		return { assistantVisible: windows.find(w => w.webContents.getURL() === "about:blank").isVisible(), wikiVisible: windows.find(w => w.webContents.getURL().includes("wiki-window=1")).isVisible() };
	});
	assert.deepEqual(afterCollapse, { assistantVisible: false, wikiVisible: true }, "collapse hides the assistant and keeps Wiki visible");
	await editor.getByText("Original content.", { exact: true }).waitFor();
	await wiki.screenshot({ path: "/tmp/pi-wiki-after-collapse.png" });
	await wiki.locator(".wiki-ask-toggle").click();
	await floating.locator(".inputbar textarea").waitFor();
	assert.equal(await floating.locator(".inputbar textarea").inputValue(), "Keep this draft across windows");
	await floating.locator(".wiki-analysis-scope").click();
	await floating.locator("dialog[open]").waitFor();
	await floating.keyboard.press("Escape");
	await floating.locator("dialog[open]").waitFor({ state: "detached" });
	await app.evaluate(({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === "about:blank");
		win.setPosition(50, 80); win.setSize(520, 780);
	});
	assert.equal(await floating.evaluate(() => innerWidth), 520);
	await floating.screenshot({ path: "/tmp/pi-native-assistant.png" });
	await floating.locator(".wiki-assistant-header button").nth(0).click();
	await wiki.locator(".wiki-assistant.is-docked").waitFor();
	assert.equal(await wiki.locator(".inputbar textarea").inputValue(), "Keep this draft across windows");
	await wiki.locator(".wiki-assistant-header button").nth(0).click();
	for (let i = 0; i < 100; i++) {
		floating = app.windows().find(page => page.url() === "about:blank");
		if (floating) break;
		await sleep(100);
	}
	await floating.locator(".inputbar textarea").waitFor();
	assert.equal(await floating.locator(".inputbar textarea").inputValue(), "Keep this draft across windows");
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === "about:blank").close());
	await wiki.locator(".wiki-ask-toggle[aria-expanded=false]").waitFor();
	await wiki.locator(".wiki-ask-toggle").click();
	for (let i = 0; i < 100; i++) {
		floating = app.windows().find(page => page.url() === "about:blank");
		if (floating) break;
		await sleep(100);
	}
	await floating.locator(".inputbar textarea").waitFor();
	assert.equal(await floating.locator(".inputbar textarea").inputValue(), "Keep this draft across windows");

	await floating.locator(".inputbar textarea").press("Enter");
	for (let i = 0; i < 100 && replies.length === 0; i++) await sleep(100);
	assert.equal(replies.length, 1, "detached composer sends through the existing Wiki session");
	await floating.getByRole("button", { name: "停止任务", exact: true }).click();
	await floating.getByRole("button", { name: "停止任务", exact: true }).waitFor({ state: "detached" });
	await wiki.waitForFunction(() => document.querySelector(".wiki-prose .fp-rich-document")?.getAttribute("contenteditable") === "true");
	await floating.getByRole("link", { name: "Open document", exact: true }).waitFor();
	const nextContext = wiki.waitForResponse(response => response.url().includes("/api/wiki") && response.request().postDataJSON()?.action === "chat-context" && response.ok());
	await floating.getByRole("link", { name: "Open document", exact: true }).click();
	await wiki.waitForURL(url => url.searchParams.get("doc") === "other.md");
	await nextContext;
	await floating.locator(".attach-chip.current-file").filter({ hasText: "other.md" }).waitFor();
	// Native title-bar close follows the same interrupt/operation contract.
	await floating.bringToFront();
	await floating.locator(".inputbar textarea").fill("Keep running until close is confirmed");
	await floating.locator(".composer-action.send").click();
	for (let i = 0; i < 100 && replies.length < 2; i++) await sleep(100);
	assert.equal(replies.length, 2);
	const closeWiki = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("wiki-window=1")).close());
	await closeWiki();
	await wiki.getByRole("dialog", { name: "对话任务仍在运行" }).waitFor();
	await wiki.getByRole("button", { name: "取消", exact: true }).click();
	assert.equal(wiki.isClosed(), false);
	await floating.getByRole("button", { name: "停止任务", exact: true }).waitFor();
	await closeWiki();
	await wiki.getByRole("dialog", { name: "对话任务仍在运行" }).waitFor();
	await Promise.all([
		wiki.waitForEvent("close"),
		wiki.getByRole("button", { name: "中断并继续", exact: true }).click({ noWaitAfter: true }).catch(error => { if (!wiki.isClosed()) throw error; }),
	]);
	assert.equal(main.isClosed(), false);
	assert.deepEqual(errors, []);
	console.log("PASS native assistant: independent window, resize, picker, dock, draft, close/reopen and guarded native close");
} catch (error) { console.error(error); throw error; } finally {
	if (app) { await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); }).catch(() => {}); await app.close(); }
	mock.closeAllConnections(); mock.close();
	rmSync(base, { recursive: true, force: true });
}
