/** Real SDK, isolated workspace and local model: Wiki mode contracts (ADR-0002). */
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
	const errors = []; page.on("pageerror", error => errors.push(error.message));
	let conversation, failWrites = false, delayWrites = false;
	const actions = [], navigation = [], prompts = [];
	page.on("websocket", ws => {
		ws.on("framereceived", ({payload}) => { const message = JSON.parse(String(payload)); if (message.type === "snapshot") conversation = message.state.conversationId; });
		ws.on("framesent", ({payload}) => { const message = JSON.parse(String(payload)); if (message.type === "switch_conversation") navigation.push(message); if (message.type === "prompt") prompts.push(message); });
	});
	await page.route("**/api/wiki", async route => {
		const body = route.request().postDataJSON(); actions.push(body.action);
		if (body.action === "write" && failWrites) return route.fulfill({status: 503, json: {error: "Save unavailable"}});
		if (body.action === "write" && delayWrites) { const response = await route.fetch(); await new Promise(r => setTimeout(r, 600)); return route.fulfill({response}); }
		return route.continue();
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".conn-dot.ok").first().waitFor({state: "attached"});
	const input = page.locator(".inputbar textarea"), view = page.locator(".wiki-view:not(.hidden)"), editor = page.locator(".wiki-prose .fp-rich-document");
	/** Enter Wiki mode from the normal view's file tree. */
	const open = async () => { await page.locator(".file-name", {hasText: "README.md"}).first().evaluate(el => el.click()); await view.waitFor(); await editor.waitFor(); };
	/** Exit Wiki mode through the view header button. */
	const close = () => page.locator(".wiki-view-header > button").last().click();
	const exited = () => view.waitFor({state: "hidden"});
	const select = async () => { await editor.locator("p").first().evaluate(el => { el.closest("[contenteditable]").focus(); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }); await page.locator(".wiki-ask-selection").waitFor(); };
	const append = async text => { await editor.locator("p").first().evaluate(el => { el.closest("[contenteditable]").focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }); await page.keyboard.type(text); };
	const saved = () => page.locator(".wiki-save-status.saved").waitFor();
	const original = conversation;

	// Entering Wiki mode is allowed while the normal conversation is running:
	// the run keeps streaming in the background and the fresh ephemeral
	// conversation is editable immediately (Q17).
	await input.fill("local background reply"); await input.press("Enter");
	await open();
	assert.notEqual(conversation, original, "entering Wiki creates a fresh ephemeral conversation");
	const ephemeral = conversation;
	assert.equal(await editor.getAttribute("contenteditable"), "true");
	assert.equal(await page.locator(".wiki-agent-chat").isVisible(), true);
	assert.equal(await page.locator(".wiki-chat-panel, .wiki-composer-area").count(), 0);
	assert.equal(await page.locator(".inputbar").count(), 1);
	// The docked chat shows the EMPTY ephemeral conversation, not the anchor.
	assert(!(await page.locator(".messages").innerText()).includes("Reply paragraph"));
	// The normal view's project panel is unmounted in Wiki mode.
	assert.equal(await page.locator(".file-tree-host").count(), 0);
	// The background reply completes in the anchor conversation.
	releaseReply();
	await page.waitForFunction(() => document.querySelector(".messages"));
	// Wiki chat carries the open document as its automatic current-file chip.
	assert.equal(await page.locator(".wiki-agent-chat .attach-chip.current-file").count(), 1, "Wiki chat must attach the open document");
	assert((await page.locator(".attach-chip.current-file").innerText()).includes("@README.md"));
	// Nested search consumes Escape; the workbench stays open.
	await page.keyboard.press("Meta+k"); await page.locator(".wiki-search-modal").waitFor();
	await page.keyboard.press("Escape"); await page.locator(".wiki-search-modal").waitFor({state: "detached"});
	assert(await view.isVisible());
	await page.getByRole("button", {name: "编辑源码", exact: true}).click();
	await page.locator(".wiki-document .fp-editor").waitFor();
	await page.getByRole("button", {name: "渲染预览", exact: true}).click(); await editor.waitFor();
	await page.locator('.wiki-insert-toolbar button[title*="表格"]').click();
	await page.locator(".wiki-table-popover").waitFor();
	await page.keyboard.press("Escape"); await page.locator(".wiki-table-popover").waitFor({state: "detached"});
	assert(await view.isVisible());

	// Exiting switches back to the anchor conversation; its transcript now
	// contains the background reply and the Wiki chip is gone.
	await close(); await exited();
	// The switch-back snapshot arrives asynchronously — wait for the anchor transcript.
	await page.locator(".messages", {hasText: "Reply paragraph 49"}).waitFor();
	assert.equal(conversation, original, "exiting Wiki returns to the anchor conversation");
	assert.equal(await page.locator(".attach-chip.current-file").count(), 0, "Closing Wiki clears its automatic context");

	// The anchor keeps its draft, attachment and scroll across the Wiki detour.
	await input.fill("Existing draft");
	await page.locator('.inputbar input[type=file]').first().setInputFiles({name: "attachment.txt", mimeType: "text/plain", buffer: Buffer.from("keep attachment")});
	await page.locator(".attach-chip.file").waitFor();
	await page.locator(".messages").evaluate(el => { el.scrollTop = 100; el.dispatchEvent(new Event("scroll")); });
	const chatScroll = await page.locator(".messages").evaluate(el => el.scrollTop);
	await open();
	assert.notEqual(conversation, ephemeral, "re-entering the same document reuses nothing: a fresh conversation is created");
	// The ephemeral chat composer starts empty — it never inherits anchor drafts.
	assert.equal(await input.inputValue(), "");
	assert.equal(await page.locator(".wiki-agent-chat .attach-chip.file").count(), 0);
	// Quotes go to the ephemeral conversation's composer, never the anchor.
	await select();
	const quoted = await page.evaluate(() => getSelection().toString());
	await page.locator(".wiki-ask-selection").click();
	await page.waitForFunction(value => document.querySelector(".inputbar textarea")?.value.includes(value), quoted.slice(0, 20));
	assert.equal(await input.inputValue(), `README.md\n\n> ${quoted}\n\n`);
	await input.fill("");
	await close(); await exited();
	await page.locator(".messages", {hasText: "local background reply"}).waitFor();
	assert.equal(await input.inputValue(), "Existing draft"); assert.equal(await page.locator(".attach-chip.file").count(), 1);
	assert.equal(await page.locator(".messages").evaluate(el => el.scrollTop), chatScroll);

	// Immediate close joins the autosave and flushes pending edits.
	await open();
	await append(" Saved on close.");
	await close(); await exited();
	assert(readFileSync(join(cwd, "README.md"), "utf8").includes("Saved on close."));

	// Failed saves keep the view open and offer explicit choices.
	await open(); failWrites = true; await append(" Unsaved text.");
	await select(); await page.locator(".wiki-ask-selection").click();
	await page.locator(".wiki-save-status.failed").waitFor();
	assert(await view.isVisible());
	await close(); await page.locator(".wiki-confirm").waitFor();
	assert(await page.locator(".wiki-confirm").evaluate(el => el.contains(document.activeElement)));
	await page.keyboard.press("Escape"); await page.locator(".wiki-confirm").waitFor({state: "detached"});
	assert(await view.isVisible(), "Escape cancels the leave guard");
	await close(); await page.getByRole("button", {name: "放弃修改", exact: true}).click(); await exited(); failWrites = false;
	await page.locator(".messages", {hasText: "local background reply"}).waitFor();
	assert(!readFileSync(join(cwd, "README.md"), "utf8").includes("Unsaved text."));

	// CAS conflict retains the editor until resolved.
	await open(); await append(" My version."); writeFileSync(join(cwd, "README.md"), "# External\n\nDisk version.\n");
	await select(); await page.locator(".wiki-ask-selection").click(); await page.locator(".wiki-conflict").waitFor();
	assert(await view.isVisible());
	await page.getByRole("button", {name: "保留我的版本", exact: true}).click(); await saved();

	// The clicked selection is immutable while an asynchronous save completes.
	delayWrites = true; await append(" Quoted change."); await select();
	const selected = await page.evaluate(() => getSelection().toString());
	await page.locator(".wiki-ask-selection").click();
	await page.evaluate(() => getSelection().removeAllRanges());
	await page.waitForFunction(value => document.querySelector(".inputbar textarea")?.value.includes(value), "Quoted change."); delayWrites = false;
	assert(await view.isVisible());
	assert.equal(await input.inputValue(), `README.md\n\n> ${selected}\n\n`);

	// Sending from the Wiki chat prompts the ephemeral conversation, flushing
	// document edits first and attaching the editor snapshot.
	await append(" Saved before panel prompt.");
	failWrites = true;
	await input.press("Enter"); await page.locator(".wiki-save-status.failed").waitFor();
	assert.equal(await editor.getAttribute("contenteditable"), "true");
	failWrites = false;
	responseGate = new Promise(resolve => { releaseReply = resolve; });
	await input.press("Enter");
	await page.waitForFunction(() => document.querySelector(".wiki-prose [contenteditable=false]"));
	assert(readFileSync(join(cwd, "README.md"), "utf8").includes("Saved before panel prompt."));
	const attachment = prompts.at(-1).attachments.find(a => a.path === "README.md");
	assert.equal(attachment.editorSnapshot.text, readFileSync(join(cwd, "README.md"), "utf8"));
	assert.equal(attachment.editorSnapshot.dirty, false);
	assert(attachment.editorSnapshot.version);
	const wikiConversation = conversation;
	assert.notEqual(wikiConversation, original);

	// Switching documents while the Wiki conversation runs asks before
	// interrupting; the interrupted conversation is deleted (Q8/Q13).
	await editor.locator("a", {hasText: "Other"}).click();
	await page.locator(".wiki-confirm", {hasText: "对话任务仍在运行"}).waitFor();
	await page.getByRole("button", {name: "取消", exact: true}).click();
	assert(await view.isVisible());
	await editor.locator("a", {hasText: "Other"}).click();
	await page.getByRole("button", {name: "中断并继续", exact: true}).click();
	await page.locator(".wiki-document-heading h1", {hasText: "Other document"}).waitFor();
	assert.notEqual(conversation, wikiConversation, "switching documents replaces the ephemeral conversation");
	assert((await page.locator(".attach-chip.current-file").innerText()).includes("@other.md"));
	await page.locator(".attach-chip.current-file .attach-remove").click();
	assert.equal(await page.locator(".attach-chip.current-file").count(), 0);

	// The file explorer references paths without navigating.
	await page.locator(".wiki-mobile-tools button").first().click();
	await page.locator(".wiki-sidebar .file-search-trigger").waitFor();
	const folder = page.locator('.wiki-tree-row[title="knowledge"]');
	await folder.waitFor();
	await folder.locator(".file-reference-action").focus();
	await folder.locator(".file-reference-action").click();
	assert((await page.locator(".attach-chip.reference").innerText()).includes("knowledge"));
	await page.locator(".attach-chip.reference .attach-remove").click();

	// A page refresh re-enters Wiki mode and reattaches the SAME ephemeral
	// conversation (Q15); the chat transcript survives the reload.
	responseGate = new Promise(resolve => { releaseReply = resolve; });
	await input.fill("Wiki only question"); await input.press("Enter");
	await page.waitForFunction(() => document.querySelector(".wiki-prose [contenteditable=false]"));
	releaseReply();
	await page.locator(".messages", {hasText: "Wiki only question"}).waitFor();
	const beforeReload = conversation;
	await page.reload();
	await page.locator(".conn-dot.ok").first().waitFor({state: "attached"});
	await view.waitFor(); await editor.waitFor();
	await page.locator(".messages", {hasText: "Wiki only question"}).waitFor();
	assert.equal(conversation, beforeReload, "refresh reattaches the same ephemeral conversation");

	// Exiting deletes the ephemeral conversation and returns to the anchor.
	await close(); await exited();
	await page.locator(".messages", {hasText: "local background reply"}).waitFor();
	assert.equal(conversation, original);
	assert.equal(navigation.some(message => message.id === original), true, "exit switches back to the anchor");

	// Chat file-link events open Wiki mode on the same terms.
	await page.evaluate(() => window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", {detail: {path: "README.md"}})));
	await view.waitFor(); await editor.waitFor();
	await close(); await exited();
	await page.locator(".messages", {hasText: "local background reply"}).waitFor();

	// A background preview keeps its own context; opening Wiki replaces the chip.
	await page.evaluate(() => window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", {detail: {path: "background.ts"}})));
	await page.locator(".attach-chip.current-file", {hasText: "@background.ts"}).waitFor();
	await page.locator(".fp-editor, .fp-code-editor, .fp-markdown").first().waitFor();
	await open();
	await page.locator(".attach-chip.current-file", {hasText: "@README.md"}).waitFor();
	await close(); await exited();
	await page.locator(".attach-chip.current-file", {hasText: "@background.ts"}).waitFor();

	// Mobile: the chat panel is an overlay toggled from the view header.
	await page.setViewportSize({width: 390, height: 844});
	// Wait out any in-flight workspace/conversation switch before re-entering.
	await page.waitForFunction(() => !document.querySelector(".protocol-banner"));
	await open();
	assert.equal(await page.locator(".wiki-agent-chat").isVisible(), false);
	await page.getByRole("button", {name: "Agent Chat", exact: true}).click();
	assert(await page.locator(".wiki-agent-chat").isVisible());
	await page.locator(".wiki-agent-header button").click();
	assert.equal(await page.locator(".wiki-agent-chat").isVisible(), false);
	await close(); await exited();
	assert.deepEqual(errors, []);
	console.log("PASS wiki mode: ephemeral conversations, background reply isolation, exit anchor, interrupt confirm, refresh restore, save/conflict/quote, explorer and mobile");
} catch (error) { console.error("pageerrors:", errors); console.error(log.slice(-6000)); throw error; }
finally {
	releaseReply();
	await browser?.close();
	await new Promise(r => mock.close(r));
	if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, "exit"); server.kill(); await stopped; }
	rmSync(base, { recursive: true, force: true });
}
