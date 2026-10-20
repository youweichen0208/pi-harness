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
	// This suite exercises docked chat; native floating coverage lives in wiki-assistant-window-test.
	await main.evaluate(() => localStorage.setItem("pi-wiki-assistant-docked", "true"));
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
	const original = new URL(wiki.url());
	const client = original.searchParams.get("client");
	const navigations = [];
	wiki.on("request", request => { if (request.isNavigationRequest()) navigations.push(request.url()); });
	const checkWindow = async (path, expectedCwd = original.searchParams.get("cwd")) => {
		const url = new URL(wiki.url());
		assert.equal(url.searchParams.get("wiki-window"), "1");
		assert.equal(url.searchParams.get("client"), client);
		assert.equal(url.searchParams.get("cwd"), expectedCwd);
		assert.equal(url.searchParams.get("doc"), path);
		assert.equal(await wiki.locator(".wiki-view:not(.hidden)").count(), 1);
		assert.equal(await main.locator(".wiki-view:not(.hidden)").count(), 0);
		assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
		assert.deepEqual(await app.evaluate(() => globalThis.wikiLinkExternal), []);
		assert.deepEqual(navigations, [], "file clicks never reload the document window");
	};
	const showChat = async () => {
		if (!await wiki.locator(".wiki-assistant").isVisible()) await wiki.getByRole("button", { name: "问 pi", exact: true }).click();
		await wiki.locator(".wiki-assistant").waitFor();
	};
	const send = async () => {
		const before = replies.length;
		const input = wiki.locator(".inputbar textarea");
		await input.fill("Show document link"); await input.press("Enter");
		for (let i = 0; i < 200 && replies.length === before; i++) await sleep(50);
		assert.equal(replies.length, before + 1);
		await wiki.locator(".wiki-agent-chat a", { hasText: "Open document" }).last().waitFor();
	};
	const pickFolder = async target => {
		await wiki.locator(".wiki-sidebar").getByRole("button", { name: "打开文件夹", exact: true }).click();
		const picker = wiki.getByRole("dialog", { name: "打开文件夹", exact: true });
		await picker.locator("input").fill(target);
		await picker.getByRole("button", { name: "打开文件夹", exact: true }).click();
	};

	const link = wiki.locator(".wiki-agent-chat a", { hasText: "Open document" }).last();
	const interrupt = wiki.getByRole("dialog", { name: "对话任务仍在运行", exact: true });
	await showChat(); await send();
	// Active tail: cancel must leave both the document and running reply intact.
	await link.click(); await interrupt.waitFor();
	await interrupt.getByRole("button", { name: "取消", exact: true }).click();
	await checkWindow("README.md");
	// Folder switches use the same explicit interruption guard.
	await pickFolder(second); await interrupt.waitFor();
	await interrupt.getByRole("button", { name: "取消", exact: true }).click();
	await checkWindow("README.md");
	// Freeze that same link by appending another paragraph. This failed before the fix.
	replies[0].append("\n\nContinuing reply.");
	await wiki.locator(".wiki-agent-chat .msg-text", { hasText: "Continuing reply." }).waitFor();
	await link.click(); await interrupt.waitFor();
	await interrupt.getByRole("button", { name: "取消", exact: true }).click();
	await checkWindow("README.md");
	await link.click(); await interrupt.waitFor();
	await interrupt.getByRole("button", { name: "中断并继续", exact: true }).click();
	await wiki.waitForFunction(() => new URL(location.href).searchParams.get("doc") === "other.md");
	await editor.getByText("Target content.", { exact: true }).waitFor();
	await checkWindow("other.md");

	// Settled reply: switching must still flush edits and preserve a failed save.
	await showChat(); await send(); replies[1].finish();
	await wiki.waitForFunction(() => document.querySelector(".wiki-prose .fp-rich-document")?.getAttribute("contenteditable") === "true");
	await wiki.route(/\/api\/wiki(?:\?|$)/, route => route.request().postDataJSON().action === "write"
		? route.fulfill({ status: 503, json: { error: "Simulated save failure" } }) : route.continue());
	await editor.locator("p").last().evaluate(element => {
		element.closest("[contenteditable]").focus();
		const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
		const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
	});
	await wiki.keyboard.type(" Preserve this draft.");
	await wiki.getByRole("button", { name: "保存失败 · 重试", exact: true }).waitFor();
	await link.click();
	const unsaved = wiki.locator(".wiki-confirm"); await unsaved.waitFor();
	await checkWindow("other.md");
	assert((await editor.innerText()).includes("Preserve this draft."));
	assert(!readFileSync(join(cwd, "other.md"), "utf8").includes("Preserve this draft."));
	await unsaved.getByRole("button", { name: "取消", exact: true }).click();
	await wiki.unrouteAll({ behavior: "ignoreErrors" });
	await link.click();
	await wiki.waitForFunction(() => new URL(location.href).searchParams.get("doc") === "README.md");
	await editor.getByText("Original content.", { exact: true }).waitFor();
	assert(readFileSync(join(cwd, "other.md"), "utf8").includes("Preserve this draft."));
	await checkWindow("README.md");
	// Failed directory validation preserves the current Wiki and permits retry.
	await pickFolder(join(base, "missing"));
	const picker = wiki.getByRole("dialog", { name: "打开文件夹", exact: true });
	await picker.getByRole("alert").waitFor();
	await checkWindow("README.md");
	await picker.getByTitle("取消", { exact: true }).click();
	// A failed save blocks folder navigation, then a retry flushes the same draft.
	await wiki.route(/\/api\/wiki(?:\?|$)/, route => route.request().postDataJSON().action === "write"
		? route.fulfill({ status: 503, json: { error: "Simulated folder save failure" } }) : route.continue());
	await editor.locator("p").last().evaluate(element => {
		element.closest("[contenteditable]").focus();
		const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
		const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
	});
	await wiki.keyboard.type(" Saved before changing folders.");
	await wiki.getByRole("button", { name: "保存失败 · 重试", exact: true }).waitFor();
	await pickFolder(second);
	await wiki.locator(".wiki-confirm").waitFor();
	await checkWindow("README.md");
	await wiki.locator(".wiki-confirm").getByRole("button", { name: "取消", exact: true }).click();
	await wiki.unrouteAll({ behavior: "ignoreErrors" });
	await pickFolder(second);
	await editor.getByText("Other folder content.", { exact: true }).waitFor();
	await wiki.waitForFunction(() => new URL(location.href).searchParams.get("doc") === "README.md");
	await checkWindow("README.md", second);
	assert(readFileSync(join(cwd, "README.md"), "utf8").includes("Saved before changing folders."));
	assert.equal(await main.locator('.file-name[title="other.md"]').count(), 1, "main project is unchanged");
	await wiki.reload(); await editor.getByText("Other folder content.", { exact: true }).waitFor();
	navigations.length = 0; // The explicit reload above is intentional.
	await checkWindow("README.md", second);
	// Confirm interrupt while changing folders; empty directories remain usable.
	await showChat(); await send();
	await pickFolder(empty); await interrupt.waitFor();
	await interrupt.getByRole("button", { name: "中断并继续", exact: true }).click();
	await wiki.waitForFunction(target => new URL(location.href).searchParams.get("cwd") === target, empty);
	await wiki.locator(".wiki-empty").waitFor();
	await checkWindow(null, empty);
	assert.equal(await wiki.locator(".wiki-sidebar.open").count(), 1);

	assert.deepEqual(errors, []);
	console.log("PASS Electron Wiki chat links: active/frozen/settled, cancel/interrupt, save failure/retry, folder switching/reload/empty/invalid, same window and client");
} catch (error) {
	if (wiki && !wiki.isClosed()) console.error({
		url: wiki.url(),
		editor: await wiki.locator(".wiki-prose .fp-rich-document").allTextContents(),
		save: await wiki.locator(".wiki-save-status, .wiki-error, .wiki-confirm").allTextContents(),
	});
	throw error;
} finally {
	await wiki?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
	// End only this test's model streams and Electron process, including failure paths.
	mock.closeAllConnections();
	if (app) {
		const timer = setTimeout(() => app.process()?.kill("SIGKILL"), 15000);
		try { await app.close(); } finally { clearTimeout(timer); }
	}
	await new Promise(resolve => mock.close(resolve));
	rmSync(base, { recursive: true, force: true });
}
