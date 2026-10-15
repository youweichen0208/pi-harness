/** Real SDK, isolated workspace and local model: document modal contracts. */
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
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: "", PI_WEB_HOST: "127.0.0.1", PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
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
		ws.on("framesent", ({payload}) => { const message = JSON.parse(String(payload)); if (["new_chat", "switch_conversation", "switch_session"].includes(message.type)) navigation.push(message); if (message.type === "prompt") prompts.push(message); });
	});
	await page.route("**/api/wiki", async route => {
		const body = route.request().postDataJSON(); actions.push(body.action);
		if (body.action === "write" && failWrites) return route.fulfill({status: 503, json: {error: "Save unavailable"}});
		if (body.action === "write" && delayWrites) { const response = await route.fetch(); await new Promise(r => setTimeout(r, 600)); return route.fulfill({response}); }
		return route.continue();
	});
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".conn-dot.ok").first().waitFor({state: "attached"});
	const input = page.locator(".inputbar textarea"), modal = page.locator(".wiki-document-dialog"), editor = page.locator(".wiki-prose .fp-rich-document");
	const open = async () => { await page.locator(".file-name", {hasText: "README.md"}).first().evaluate(el => el.click()); await editor.waitFor(); };
	const close = () => page.locator(".wiki-modal-header > button").last().click();
	const select = async () => { await editor.locator("p").first().evaluate(el => { el.closest("[contenteditable]").focus(); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }); await page.locator(".wiki-ask-selection").waitFor(); };
	const append = async text => { await editor.locator("p").first().evaluate(el => { el.closest("[contenteditable]").focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }); await page.keyboard.type(text); };
	const saved = () => page.locator(".wiki-save-status.saved").waitFor();
	const original = conversation;
	// A reply completes while the editor is open, in the original conversation.
	await input.fill("local background reply"); await input.press("Enter");
	await open();
	// The run may still be starting (SDK 1.2 counts it busy first); wait for the lock like the panel case below.
	await page.waitForFunction(() => document.querySelector(".wiki-prose [contenteditable=false]"));
	releaseReply();
	await page.waitForFunction(() => document.querySelector(".wiki-prose [contenteditable=true]"));
	assert((await page.locator(".messages").innerText()).includes("Reply paragraph 49"));
	await close(); await modal.waitFor({state: "detached"});
	await input.fill("Existing draft");
	await page.locator('.inputbar input[type=file]').first().setInputFiles({name: "attachment.txt", mimeType: "text/plain", buffer: Buffer.from("keep attachment")});
	await page.locator(".attach-chip.file").waitFor();
	// Like a user scroll, the list sees the new position before the next render.
	await page.locator(".messages").evaluate(el => { el.scrollTop = 100; el.dispatchEvent(new Event("scroll")); });
	const chatScroll = await page.locator(".messages").evaluate(el => el.scrollTop);
	await open();
	assert.equal(await page.locator(".wiki-agent-chat .attach-chip.current-file").count(), 1, "Wiki chat must attach the open document");
	assert((await page.locator(".attach-chip.current-file").innerText()).includes("@README.md"));
	assert.equal(conversation, original); assert.equal(await page.locator(".wiki-chat-panel, .wiki-composer-area").count(), 0);
	assert(await page.locator(".wiki-agent-chat").isVisible());
	assert.equal(await page.locator(".inputbar").count(), 1);
	assert.equal(await page.locator(".wiki-agent-chat textarea").inputValue(), "Existing draft");
	assert.equal(await page.locator(".wiki-sidebar").isVisible(), false);
	const box = await modal.boundingBox(); assert(Math.abs(box.width - 1440 * .92) < 2); assert(Math.abs(box.height - 900) < 2);
	await page.locator(".wiki-scroll").evaluate(el => el.scrollTop = 500);
	await page.getByRole("button", {name: "全屏显示文档", exact: true}).click();
	await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
	assert.equal(Math.round((await modal.boundingBox()).width), 1440);
	// The document dialog stays above the fullscreen page.
	assert(await modal.evaluate(el => el.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2))));
	await page.getByRole("button", {name: "退出全屏", exact: true}).click();
	await page.waitForFunction(() => !document.fullscreenElement);
	assert(Math.abs((await modal.boundingBox()).width - 1440 * .92) < 2);
	assert.equal(await page.locator(".wiki-scroll").evaluate(el => el.scrollTop), 500);
	// Leaving fullscreen elsewhere (Esc, OS controls) restores the size and label.
	await page.getByRole("button", {name: "全屏显示文档", exact: true}).click();
	await page.waitForFunction(() => document.fullscreenElement);
	await page.evaluate(() => document.exitFullscreen());
	await page.getByRole("button", {name: "全屏显示文档", exact: true}).waitFor();
	assert(Math.abs((await modal.boundingBox()).width - 1440 * .92) < 2);
	await close(); await modal.waitFor({state: "detached"});
	assert.equal(await page.locator(".attach-chip.current-file").count(), 0, "Closing Wiki clears its automatic context");
	assert.equal(await input.inputValue(), "Existing draft"); assert.equal(await page.locator(".attach-chip.file").count(), 1);
	assert.equal(await page.locator(".messages").evaluate(el => el.scrollTop), chatScroll);
	await open(); assert.equal(await page.locator(".wiki-scroll").evaluate(el => el.scrollTop), 500);
	// Nested search consumes Escape; outer dialog constrains focus.
	await page.keyboard.press("Meta+k"); await page.locator(".wiki-search-modal").waitFor();
	await page.keyboard.press("Escape"); await page.locator(".wiki-search-modal").waitFor({state: "detached"}); assert(await modal.isVisible());
	for (let i = 0; i < 25; i++) { await page.keyboard.press("Tab"); assert(await modal.evaluate(el => el.contains(document.activeElement))); }
	await page.keyboard.press("Meta+n"); assert.equal(conversation, original);
	await page.getByRole("button", {name: "编辑源码", exact: true}).click();
	await page.locator(".wiki-document .fp-editor").waitFor();
	await page.getByRole("button", {name: "渲染预览", exact: true}).click(); await editor.waitFor();
	await page.locator('.wiki-insert-toolbar button[title*="表格"]').click();
	await page.locator(".wiki-table-popover").waitFor();
	for (let i = 0; i < 10; i++) { await page.keyboard.press("Tab"); assert(await page.locator(".wiki-table-popover").evaluate(el => el.contains(document.activeElement))); }
	await page.keyboard.press("Escape"); await page.locator(".wiki-table-popover").waitFor({state: "detached"}); assert(await modal.isVisible());
	await page.screenshot({path: "/tmp/pi-wiki-document-modal.png"});
	// Immediate close flushes pending edits; failed saves offer explicit choices.
	await append(" Saved on close.");
	const caret = await page.evaluate(() => ({offset: getSelection().anchorOffset, text: getSelection().anchorNode.textContent}));
	await page.getByRole("button", {name: "全屏显示文档", exact: true}).click();
	await page.getByRole("button", {name: "退出全屏", exact: true}).click();
	assert.deepEqual(await page.evaluate(() => ({offset: getSelection().anchorOffset, text: getSelection().anchorNode.textContent})), caret);
	assert((await editor.innerText()).includes("Saved on close."));
	await close(); await modal.waitFor({state: "detached"});
	assert(readFileSync(join(cwd, "README.md"), "utf8").includes("Saved on close."));
	await open(); failWrites = true; await append(" Unsaved text.");
	await select(); await page.locator(".wiki-ask-selection").click();
	await page.locator(".wiki-save-status.failed").waitFor(); assert(await modal.isVisible()); assert.equal(await input.inputValue(), "Existing draft");
	await close(); await page.locator(".wiki-confirm").waitFor();
	assert(await page.locator(".wiki-confirm").evaluate(el => el.contains(document.activeElement)));
	await page.keyboard.press("Escape"); await page.locator(".wiki-confirm").waitFor({state: "detached"}); assert(await modal.isVisible());
	await close(); await page.getByRole("button", {name: "放弃修改", exact: true}).click(); await modal.waitFor({state: "detached"}); failWrites = false;
	assert(!readFileSync(join(cwd, "README.md"), "utf8").includes("Unsaved text."));
	// CAS conflict retains both editor and original chat until resolved.
	await open(); await append(" My version."); writeFileSync(join(cwd, "README.md"), "# External\n\nDisk version.\n");
	await select(); await page.locator(".wiki-ask-selection").click(); await page.locator(".wiki-conflict").waitFor();
	assert.equal(await input.inputValue(), "Existing draft"); assert(await modal.isVisible());
	await page.getByRole("button", {name: "保留我的版本", exact: true}).click(); await saved();
	// The clicked selection is immutable while an asynchronous save completes.
	delayWrites = true; await append(" Quoted change."); await select();
	const selected = await page.evaluate(() => getSelection().toString());
	await page.locator(".wiki-ask-selection").click();
	await page.evaluate(() => getSelection().removeAllRanges());
	await page.waitForFunction(() => document.querySelector(".inputbar textarea")?.value.includes("Quoted change.")); delayWrites = false;
	assert(await modal.isVisible());
	assert.equal(await input.inputValue(), `Existing draft\n\nREADME.md\n\n> ${selected}\n\n`);
	assert.equal(await page.locator(".attach-chip.file").count(), 1);
	await page.waitForFunction(() => document.activeElement === document.querySelector(".inputbar textarea"));
	assert(!actions.includes("prompt") && !actions.includes("new-conversation")); assert.deepEqual(navigation, []);
	// The same composer sends from the right panel, flushing document edits first.
	await input.fill("Panel prompt");
	await append(" Saved before panel prompt.");
	failWrites = true;
	await input.press("Enter"); await page.locator(".wiki-save-status.failed").waitFor();
	assert.equal(await input.inputValue(), "Panel prompt");
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
	releaseReply();
	await page.waitForFunction(() => document.querySelector(".wiki-prose [contenteditable=true]"));
	assert.equal(conversation, original);
	await input.fill("Draft written in panel");
	await page.getByRole("button", {name: "Agent Chat", exact: true}).click();
	assert.equal(await page.locator(".wiki-agent-chat").isVisible(), false);
	await page.getByRole("button", {name: "Agent Chat", exact: true}).click();
	assert.equal(await input.inputValue(), "Draft written in panel");
	const separator = page.locator(".wiki-agent-chat > [role=separator]");
	await separator.focus(); await page.keyboard.press("ArrowLeft");
	assert.equal(await separator.getAttribute("aria-valuenow"), "410");
	await page.keyboard.press("Home");
	await close(); await modal.waitFor({state: "detached"});
	assert.equal(await input.inputValue(), "Draft written in panel");
	// File links and document switching keep the same conversation.
	await open(); await editor.locator("a", {hasText: "Other"}).click(); await page.locator(".wiki-document-heading h1", {hasText: "Other document"}).waitFor();
	assert.equal(conversation, original);
	assert((await page.locator(".attach-chip.current-file").innerText()).includes("@other.md"));
	await page.locator(".attach-chip.current-file .attach-remove").click();
	assert.equal(await page.locator(".attach-chip.current-file").count(), 0);
	await close();
	// The file explorer matches the shared layout and references paths without navigating.
	await open();
	await page.locator(".wiki-mobile-tools button").first().click();
	await page.locator(".wiki-sidebar .file-search-trigger").waitFor();
	const folder = page.locator('.wiki-tree-row[title="knowledge"]');
	await folder.waitFor();
	assert.equal(await folder.locator(".file-tree-icon svg").count(), 1);
	await folder.locator(".file-reference-action").focus();
	await folder.locator(".file-reference-action").click();
	assert((await page.locator(".attach-chip.reference").innerText()).includes("knowledge"));
	assert.equal(await folder.getAttribute("aria-expanded"), "false");
	await page.locator(".attach-chip.reference .attach-remove").click();
	await page.screenshot({path: "/tmp/pi-file-explorer.png"});
	await page.keyboard.press("Meta+p"); await page.locator(".wiki-search-modal").waitFor();
	await page.keyboard.press("Escape"); await close();
	await page.keyboard.press("Meta+p");
	await page.locator(".cs-modal").waitFor();
	assert.equal(await page.getByRole("tab", {name: "代码", exact: true}).getAttribute("aria-selected"), "true");
	await page.locator(".cs-head input").press("Tab");
	assert.equal(await page.locator(".cs-head input").getAttribute("placeholder"), "搜索文件");
	await page.keyboard.press("Escape");
	// Chat file-link events and global filename search use the same modal.
	await page.evaluate(() => window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", {detail: {path: "README.md"}})));
	await editor.waitFor(); await page.mouse.click(5, 5); await modal.waitFor({state: "detached"});
	await page.keyboard.press("Meta+k"); await page.locator(".gs-input-row input").fill("README.md");
	await page.locator(".gs-modal button", {hasText: "README.md"}).first().click();
	await editor.waitFor(); assert.equal(conversation, original); await close();
	// A background preview must neither replace Wiki context nor lose its own context on close.
	await page.evaluate(() => window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", {detail: {path: "background.ts"}})));
	await page.locator(".attach-chip.current-file", {hasText: "@background.ts"}).waitFor();
	await open();
	await page.locator(".attach-chip.current-file", {hasText: "@README.md"}).waitFor();
	await close();
	await page.locator(".attach-chip.current-file", {hasText: "@background.ts"}).waitFor();
	await page.setViewportSize({width: 390, height: 844}); await open();
	assert.equal(Math.round((await modal.boundingBox()).width), 390); assert.equal(Math.round((await modal.boundingBox()).height), 844);
	assert.equal(await page.locator(".wiki-agent-chat").isVisible(), false);
	await page.getByRole("button", {name: "Agent Chat", exact: true}).click();
	assert(await page.locator(".wiki-agent-chat").isVisible());
	assert.equal(await input.inputValue(), "Draft written in panel");
	await page.locator(".wiki-agent-header button").click();
	await page.locator(".wiki-modal-header > button").last().focus();
	await page.keyboard.press("Escape"); await modal.waitFor({state: "detached"});
	assert.deepEqual(errors, []);
	console.log("PASS document modal: session, background reply, draft/attachment/scroll, save/conflict/quote, focus, resize and mobile");
} catch (error) { console.error(log.slice(-6000)); throw error; }
finally {
	releaseReply();
	await browser?.close();
	await new Promise(r => mock.close(r));
	if (server.exitCode === null && server.signalCode === null) { const stopped = once(server, "exit"); server.kill(); await stopped; }
	rmSync(base, { recursive: true, force: true });
}
