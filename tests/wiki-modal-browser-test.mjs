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

const port = 9270;
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
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port + 1}`, apiKey: "unused", models: [{ id: "unused", name: "Unused local model", input: ["text"], contextWindow: 32000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "unused" }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "unused" } }));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: "", PI_WEB_HOST: "127.0.0.1", PI_WEB_PKG_ROOT: process.cwd(), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
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
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(15000);
	// 每个窗口自己的 WebSocket 上跟踪最新快照会话、发送的 prompt 与切会话导航。
	const states = new Map();
	// Conversation ids ("c2"…) are only unique WITHIN one ClientSession — every
	// window counts its own. Qualify snapshots with the window's URL client id
	// so cross-window comparisons (main vs Wiki, reused window vs before) are valid.
	const clientOf = target => { try { return new URL(target.url()).searchParams.get("client") ?? "main"; } catch { return "main"; } };
	const track = target => {
		const state = { conversation: undefined, prompts: [], navigation: [] };
		states.set(target, state);
		target.on("pageerror", error => errors.push(error.message));
		target.on("websocket", ws => {
			ws.on("framereceived", ({payload}) => { const message = JSON.parse(String(payload)); if (message.type === "snapshot") state.conversation = `${clientOf(target)}:${message.state.conversationId}`; });
			ws.on("framesent", ({payload}) => { const message = JSON.parse(String(payload)); if (message.type === "switch_conversation") state.navigation.push(message); if (message.type === "prompt") state.prompts.push(message); });
		});
		return state;
	};
	const main = track(page);
	let failWrites = false, delayWrites = false;
	const actions = [];
	// Context 级路由：主页面与 Wiki 弹窗的 /api/wiki 都经过这里。
	await page.context().route("**/api/wiki", async route => {
		const body = route.request().postDataJSON(); actions.push(body.action);
		if (body.action === "write" && failWrites) return route.fulfill({status: 503, json: {error: "Save unavailable"}});
		if (body.action === "write" && delayWrites) { const response = await route.fetch(); await new Promise(r => setTimeout(r, 600)); return route.fulfill({response}); }
		return route.continue();
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".conn-dot.ok").first().waitFor({state: "attached"});
	const input = page.locator(".inputbar textarea");
	/** @type {import("playwright-core").Page | null} */
	let wikiPage = null, wiki;
	const wireWiki = target => {
		wikiPage = target;
		target.setDefaultTimeout(20000);
		wiki = {
			page: target,
			state: track(target),
			view: target.locator(".wiki-view:not(.hidden)"),
			editor: target.locator(".wiki-prose .fp-rich-document"),
			input: target.locator(".inputbar textarea"),
		};
	};
	/** 从主窗口文件树进入 Wiki：打开（或复用）独立 Wiki 窗口，主窗口保持 normal 视图。 */
	const open = async () => {
		const reuse = wikiPage && !wikiPage.isClosed();
		const popupPromise = reuse ? null : page.context().waitForEvent("page");
		await page.locator(".file-name", {hasText: "README.md"}).first().evaluate(el => el.click());
		if (!reuse) wireWiki(await popupPromise);
		await wiki.view.waitFor(); await wiki.editor.waitFor();
	};
	/** 退出 Wiki mode = 关闭 Wiki 窗口。 */
	const close = async () => {
		// Subscribe BEFORE clicking: window.close() can fire while the click
		// promise is still resolving, which would lose the close event.
		const closed = wiki.page.waitForEvent("close");
		await wiki.page.locator(".wiki-view-header > button").last().click();
		await closed;
	};
	const select = async () => { await wiki.editor.locator("p").first().evaluate(el => { el.closest("[contenteditable]").focus(); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }); await wiki.page.locator(".wiki-ask-selection").waitFor(); };
	const append = async text => { await wiki.editor.locator("p").first().evaluate(el => { el.closest("[contenteditable]").focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }); await wiki.page.keyboard.type(text); };
	const saved = () => wiki.page.locator(".wiki-save-status.saved").waitFor();
	const showChat = async () => {
		if (!await wiki.page.locator(".wiki-agent-chat").isVisible()) await wiki.page.getByRole("button", {name: "问 pi", exact: true}).click();
		await wiki.page.locator(".wiki-agent-chat").waitFor();
	};

	await input.fill("local background reply"); await input.press("Enter");
	const original = main.conversation;

	// Entering Wiki opens a separate window: the main window keeps the normal
	// conversation (running or not), the Wiki window boots a fresh ephemeral one.
	await open();
	assert.equal(wiki.page.url().includes("wiki-window=1"), true, "Wiki runs in a detached window");
	assert.equal(main.conversation, original, "the main window never leaves its conversation");
	assert.notEqual(wiki.state.conversation, original, "the Wiki window runs a fresh ephemeral conversation");
	const ephemeral = wiki.state.conversation;
	assert.equal(await wiki.editor.getAttribute("contenteditable"), "true");
	assert.equal(await wiki.page.locator(".wiki-agent-chat").isVisible(), false, "document reading is the default; Ask pi opens on demand");
	assert.equal(await wiki.page.locator(".workspace-column > .topbar").count(), 0, "the detached Wiki no longer renders the main app topbar");
	assert.equal(await wiki.page.locator(".statusbar").count(), 0, "the detached Wiki no longer renders the main Git statusbar");
	assert(await wiki.page.locator(".wiki-window-header").isVisible());
	assert.equal(await wiki.page.locator(".wiki-chat-panel, .wiki-composer-area").count(), 0);
	assert.equal(await wiki.page.locator(".inputbar").count(), 1);
	await wiki.page.getByRole("button", {name: "目录", exact: true}).click();
	await wiki.page.locator(".wiki-sidebar .file-search-trigger").waitFor();
	await wiki.page.getByRole("button", {name: "目录", exact: true}).click();
	await wiki.page.locator(".wiki-sidebar").waitFor({state: "hidden"});
	await wiki.page.setViewportSize({width: 1440, height: 900});
	await wiki.page.screenshot({path: "tests/scratch/wiki-window-1440.png"});
	// The on-demand chat shows the EMPTY ephemeral conversation, not the main window's.
	await wiki.page.setViewportSize({width: 1100, height: 800});
	await showChat();
	assert(!(await wiki.page.locator(".messages").innerText()).includes("Reply paragraph"));
	await wiki.page.screenshot({path: "tests/scratch/wiki-window-ask-1100.png"});
	// The Wiki window's own chrome has no visible project tree; the main window keeps its own.
	assert.equal(await wiki.page.locator(".file-list-host").isVisible(), false);
	assert.equal(await page.locator(".file-list-host").isVisible(), true, "main window keeps its normal layout");
	// The background reply completes in the main window's conversation.
	releaseReply();
	await page.locator(".messages", {hasText: "Reply paragraph 49"}).waitFor();
	// Wiki chat carries the open document as its automatic current-file chip.
	assert.equal(await wiki.page.locator(".wiki-agent-chat .attach-chip.current-file").count(), 1, "Wiki chat must attach the open document");
	assert((await wiki.page.locator(".attach-chip.current-file").innerText()).includes("@README.md"));
	// Nested search consumes Escape; the workbench stays open.
	await wiki.page.getByRole("button", {name: "搜索全部文件", exact: true}).click(); await wiki.page.locator(".wiki-search-modal").waitFor();
	await wiki.page.keyboard.press("Escape"); await wiki.page.locator(".wiki-search-modal").waitFor({state: "detached"});
	assert(await wiki.view.isVisible());
	const documentWidth = await wiki.page.locator(".wiki-main").evaluate(el => Math.round(el.getBoundingClientRect().width));
	await wiki.page.getByRole("button", {name: "最近改动", exact: true}).click();
	await wiki.page.locator(".wiki-changes").waitFor();
	assert.equal(await wiki.page.locator(".wiki-changes").evaluate(el => getComputedStyle(el).position), "absolute");
	assert.equal(await wiki.page.locator(".wiki-main").evaluate(el => Math.round(el.getBoundingClientRect().width)), documentWidth, "recent changes overlay instead of squeezing the document");
	await wiki.page.screenshot({path: "tests/scratch/wiki-window-changes-1100.png"});
	await wiki.page.locator(".wiki-changes > header > button").click();
	await wiki.page.locator(".wiki-changes").waitFor({state: "detached"});
	await wiki.page.getByRole("button", {name: "编辑源码", exact: true}).click();
	await wiki.page.locator(".wiki-document .fp-editor").waitFor();
	await wiki.page.getByRole("button", {name: "渲染预览", exact: true}).click(); await wiki.editor.waitFor();
	await wiki.page.locator('.wiki-insert-toolbar button[title*="表格"]').click();
	await wiki.page.locator(".wiki-table-popover").waitFor();
	await wiki.page.keyboard.press("Escape"); await wiki.page.locator(".wiki-table-popover").waitFor({state: "detached"});
	assert(await wiki.view.isVisible());

	// Exiting closes the Wiki window; the main window never moved and keeps no Wiki chip.
	await close();
	assert.equal(main.conversation, original, "the main window stays on its conversation");
	assert.equal(main.navigation.length, 0, "detached Wiki never drives switch_conversation on the main window");
	assert.equal(await page.locator(".attach-chip.current-file").count(), 0, "the main window never gets a Wiki chip");

	// The main window keeps its draft, attachment and scroll across the Wiki detour.
	await input.fill("Existing draft");
	await page.locator('.inputbar input[type=file]').first().setInputFiles({name: "attachment.txt", mimeType: "text/plain", buffer: Buffer.from("keep attachment")});
	await page.locator(".attach-chip.file").waitFor();
	await page.locator(".messages").evaluate(el => { el.scrollTop = 100; el.dispatchEvent(new Event("scroll")); });
	const chatScroll = await page.locator(".messages").evaluate(el => el.scrollTop);
	await open();
	assert.notEqual(wiki.state.conversation, ephemeral, "re-entering the same document reuses nothing: a fresh conversation is created");
	// The ephemeral chat composer starts empty — it never inherits main-window drafts.
	assert.equal(await wiki.input.inputValue(), "");
	assert.equal(await wiki.page.locator(".wiki-agent-chat .attach-chip.file").count(), 0);
	// Quotes go to the ephemeral conversation's composer, never the main window.
	await select();
	const quoted = await wiki.page.evaluate(() => getSelection().toString());
	await wiki.page.locator(".wiki-ask-selection").click();
	await wiki.page.waitForFunction(value => document.querySelector(".inputbar textarea")?.value.includes(value), quoted.slice(0, 20));
	assert.equal(await wiki.input.inputValue(), `README.md\n\n> ${quoted}\n\n`);
	await wiki.input.fill("");
	await close();
	assert.equal(await input.inputValue(), "Existing draft"); assert.equal(await page.locator(".attach-chip.file").count(), 1);
	assert.equal(await page.locator(".messages").evaluate(el => el.scrollTop), chatScroll);

	// Immediate close joins the autosave and flushes pending edits.
	await open();
	await append(" Saved on close.");
	await close();
	assert(readFileSync(join(cwd, "README.md"), "utf8").includes("Saved on close."));

	// Failed saves keep the window open and offer explicit choices.
	await open(); failWrites = true; await append(" Unsaved text.");
	await select(); await wiki.page.locator(".wiki-ask-selection").click();
	await wiki.page.locator(".wiki-save-status.failed").waitFor();
	assert(await wiki.view.isVisible());
	await wiki.page.locator(".wiki-view-header > button").last().click(); await wiki.page.locator(".wiki-confirm").waitFor();
	assert(await wiki.page.locator(".wiki-confirm").evaluate(el => el.contains(document.activeElement)));
	await wiki.page.keyboard.press("Escape"); await wiki.page.locator(".wiki-confirm").waitFor({state: "detached"});
	assert(await wiki.view.isVisible(), "Escape cancels the leave guard");
	await wiki.page.locator(".wiki-view-header > button").last().click();
	const discardClosed = wiki.page.waitForEvent("close");
	await wiki.page.getByRole("button", {name: "放弃修改", exact: true}).click();
	await discardClosed; failWrites = false;
	assert(!readFileSync(join(cwd, "README.md"), "utf8").includes("Unsaved text."));

	// CAS conflict retains the editor until resolved.
	await open(); await append(" My version."); writeFileSync(join(cwd, "README.md"), "# External\n\nDisk version.\n");
	await select(); await wiki.page.locator(".wiki-ask-selection").click(); await wiki.page.locator(".wiki-conflict").waitFor();
	assert(await wiki.view.isVisible());
	await wiki.page.getByRole("button", {name: "保留我的版本", exact: true}).click(); await saved();

	// The clicked selection is immutable while an asynchronous save completes.
	delayWrites = true; await append(" Quoted change."); await select();
	const selected = await wiki.page.evaluate(() => getSelection().toString());
	await wiki.page.locator(".wiki-ask-selection").click();
	await wiki.page.evaluate(() => getSelection().removeAllRanges());
	await wiki.page.waitForFunction(value => document.querySelector(".inputbar textarea")?.value.includes(value), "Quoted change."); delayWrites = false;
	assert(await wiki.view.isVisible());
	assert.equal(await wiki.input.inputValue(), `README.md\n\n> ${selected}\n\n`);

	// Sending from the Wiki chat prompts the ephemeral conversation, flushing
	// document edits first and attaching the editor snapshot.
	await append(" Saved before panel prompt.");
	failWrites = true;
	await wiki.input.press("Enter"); await wiki.page.locator(".wiki-save-status.failed").waitFor();
	assert.equal(await wiki.editor.getAttribute("contenteditable"), "true");
	failWrites = false;
	responseGate = new Promise(resolve => { releaseReply = resolve; });
	await wiki.input.press("Enter");
	await wiki.page.waitForFunction(() => document.querySelector(".wiki-prose [contenteditable=false]"));
	assert(readFileSync(join(cwd, "README.md"), "utf8").includes("Saved before panel prompt."));
	const attachment = wiki.state.prompts.at(-1).attachments.find(a => a.path === "README.md");
	assert.equal(attachment.editorSnapshot.text, readFileSync(join(cwd, "README.md"), "utf8"));
	assert.equal(attachment.editorSnapshot.dirty, false);
	assert(attachment.editorSnapshot.version);
	const wikiConversation = wiki.state.conversation;
	assert.notEqual(wikiConversation, original);

	// Switching documents while the Wiki conversation runs asks before
	// interrupting; the interrupted conversation is deleted (Q8/Q13).
	await wiki.editor.locator("a", {hasText: "Other"}).click();
	await wiki.page.locator(".wiki-confirm", {hasText: "对话任务仍在运行"}).waitFor();
	await wiki.page.getByRole("button", {name: "取消", exact: true}).click();
	assert(await wiki.view.isVisible());
	await wiki.editor.locator("a", {hasText: "Other"}).click();
	await wiki.page.getByRole("button", {name: "中断并继续", exact: true}).click();
	await wiki.page.locator(".wiki-document-heading h1", {hasText: "Other document"}).waitFor();
	assert.notEqual(wiki.state.conversation, wikiConversation, "switching documents replaces the ephemeral conversation");
	assert.equal(await wiki.page.locator(".wiki-agent-chat").isVisible(), false, "a new document returns to the reading-first layout");
	await showChat();
	assert((await wiki.page.locator(".attach-chip.current-file").innerText()).includes("@other.md"));
	await wiki.page.locator(".attach-chip.current-file .attach-remove").click();
	assert.equal(await wiki.page.locator(".attach-chip.current-file").count(), 0);

	// The file explorer references paths without navigating.
	await wiki.page.getByRole("button", {name: "目录", exact: true}).click();
	await wiki.page.locator(".wiki-sidebar .file-search-trigger").waitFor();
	const folder = wiki.page.locator('.wiki-tree-row[title="knowledge"]');
	await folder.waitFor();
	await folder.locator(".file-reference-action").focus();
	await folder.locator(".file-reference-action").click();
	assert((await wiki.page.locator(".attach-chip.reference").innerText()).includes("knowledge"));
	await wiki.page.locator(".attach-chip.reference .attach-remove").click();

	// A page refresh re-enters Wiki mode and reattaches the SAME ephemeral
	// conversation (Q15); the chat transcript survives the reload.
	responseGate = new Promise(resolve => { releaseReply = resolve; });
	await wiki.input.fill("Wiki only question"); await wiki.input.press("Enter");
	await wiki.page.waitForFunction(() => document.querySelector(".wiki-prose [contenteditable=false]"));
	releaseReply();
	await wiki.page.locator(".messages", {hasText: "Wiki only question"}).waitFor();
	const beforeReload = wiki.state.conversation;
	await wiki.page.reload();
	await wiki.page.locator(".wiki-window-header").waitFor();
	await wiki.view.waitFor(); await wiki.editor.waitFor();
	try { await wiki.page.locator(".messages", {hasText: "Wiki only question"}).waitFor({timeout: 8000}); } catch (e) {
		console.error("[dbg-reload] url:", wiki.page.url());
		console.error("[dbg-reload] messages:", (await wiki.page.locator(".messages").innerText().catch(() => "(none)")).slice(0, 300));
		console.error("[dbg-reload] conversation:", wiki.state.conversation, "beforeReload:", beforeReload);
		console.error("[dbg-reload] wiki-confirm:", await wiki.page.locator(".wiki-confirm").count(), "conflict:", await wiki.page.locator(".wiki-conflict").count());
		throw e;
	}
	assert.equal(wiki.state.conversation, beforeReload, "refresh reattaches the same ephemeral conversation");

	// Reusing the open window with a different document boots that document
	// instead of reattaching the stale one (named-window navigation).
	await page.locator(".file-name", {hasText: "other.md"}).first().evaluate(el => el.click());
	await wiki.page.locator(".wiki-document-heading h1", {hasText: "Other document"}).waitFor();
	for (let i = 0; i < 100 && wiki.state.conversation === beforeReload; i++) await new Promise(r => setTimeout(r, 100));
	assert.notEqual(wiki.state.conversation, beforeReload, "navigating the reused window replaces the conversation");

	// Exiting deletes the ephemeral conversation by closing the window; the main
	// window's conversation and navigation history are untouched throughout.
	await close();
	assert.equal(main.conversation, original);
	assert.equal(main.navigation.length, 0, "exit never switches the main window");

	// Chat file-link events on the main window open the Wiki window on the same terms.
	const popupPromise = page.context().waitForEvent("page");
	await page.evaluate(() => window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", {detail: {path: "README.md"}})));
	wireWiki(await popupPromise);
	await wiki.view.waitFor(); await wiki.editor.waitFor();
	await close();
	await page.locator(".messages", {hasText: "local background reply"}).waitFor();

	// A background preview on the main window keeps its own context; the Wiki
	// window carries its own chip and closing it leaves the preview untouched.
	await page.evaluate(() => window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", {detail: {path: "background.ts"}})));
	await page.locator(".attach-chip.current-file", {hasText: "@background.ts"}).waitFor();
	await page.locator(".fp-editor, .fp-code-editor, .fp-markdown").first().waitFor();
	await open();
	await showChat();
	await wiki.page.locator(".attach-chip.current-file", {hasText: "@README.md"}).waitFor();
	await close();
	await page.locator(".attach-chip.current-file", {hasText: "@background.ts"}).waitFor();

	// Mobile: the Wiki window's chat panel is an overlay toggled from the view header.
	await open();
	await wiki.page.setViewportSize({width: 720, height: 800});
	await wiki.page.reload();
	await wiki.page.locator(".wiki-window-header").waitFor();
	await wiki.view.waitFor(); await wiki.editor.waitFor();
	assert.equal(await wiki.page.locator(".wiki-agent-chat").isVisible(), false);
	assert(await wiki.page.locator(".wiki-window-header").evaluate(el => el.scrollWidth <= el.clientWidth), "720px titlebar stays inside the window");
	await wiki.page.screenshot({path: "tests/scratch/wiki-window-720.png"});
	await wiki.page.setViewportSize({width: 390, height: 844});
	assert(await wiki.page.locator(".wiki-window-header").evaluate(el => el.scrollWidth <= el.clientWidth), "390px titlebar stays inside the window");
	await wiki.page.screenshot({path: "tests/scratch/wiki-window-390.png"});
	await wiki.page.getByRole("button", {name: "问 pi", exact: true}).click();
	assert(await wiki.page.locator(".wiki-agent-chat").isVisible());
	await wiki.page.locator(".wiki-agent-header button").click();
	assert.equal(await wiki.page.locator(".wiki-agent-chat").isVisible(), false);
	await close();
	assert.deepEqual(errors, []);
	console.log("PASS wiki mode: detached window, ephemeral conversations, main-window isolation, interrupt confirm, window reuse, refresh restore, save/conflict/quote, explorer and mobile");
} catch (error) { console.error("pageerrors:", errors); console.error(log.slice(-6000)); throw error; }
finally {
	releaseReply();
	await browser?.close();
	await new Promise(r => mock.close(r));
	if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, "exit"); server.kill(); await stopped; }
	rmSync(base, { recursive: true, force: true });
}
