// Zero-model regression: real native extension callbacks across two conversations.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { mergeSnapshot } from "./lib/snapshots.mjs";
import { testEnv } from "./lib/test-env.mjs";
let PORT, harness, state;
const root = mkdtempSync(join(tmpdir(), "pi-extension-ui-"));
const agent = join(root, "data", "omp", "agent"), cwd = join(root, "work");
mkdirSync(join(agent, "extensions"), { recursive: true }); mkdirSync(cwd);
writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "unused", models: ["fixture", "fixture-alt"].map(id => ({ id, reasoning: true, thinking: { mode: "effort", efforts: ["low", "medium", "high"], defaultLevel: "medium" }, input: ["text"], contextWindow: 32000, maxTokens: 1024 })) } } }));
const settings = JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: true }, compaction: { enabled: true } });
writeFileSync(join(agent, "config.yml"), settings);
writeFileSync(join(agent, "extensions/ui.ts"), `export default function(pi) {
 let calls = 0;
 pi.registerCommand("fixture-retain", { handler: async (args, ctx) => { calls++; await new Promise(resolve => setTimeout(resolve, 400)); ctx.ui.notify("retain-call:" + calls); ctx.ui.notify("retain-upload:" + args.includes("frozen upload")); if(args.split("\\n", 1)[0].trim() === "fail") throw new Error("fixture failure"); } });
 pi.registerCommand("fixture-ui", { handler: async (args, ctx) => {
  const ui = ctx.ui; ui.setWidget("same", [args]); ctx.ui.setStatus("same", args); ctx.ui.setTitle("title-" + args);
  pi.sendMessage({customType:"fixture", content:"fixture-" + args, display:true});
  void ctx.ui.confirm("permission-" + args, "Allow?").then(value => ui.notify("answer-" + args + ":" + value));
 }});
 pi.registerCommand("fixture-editor", { handler: async (args, ctx) => { const text = await ctx.ui.editor("multiline", "first\\nsecond"); if(text !== undefined) ctx.ui.setEditorText(text); } });
 pi.registerCommand("fixture-timeout", { handler: async (args, ctx) => { void ctx.ui.input("timeout", "", {timeout:200}).then(value => ctx.ui.notify("timeout:" + value)); } });
 pi.registerCommand("fixture-mcp", { handler: async (_args, ctx) => ctx.ui.notify("third-party-mcp") });
 pi.registerCommand("mcp", { handler: async (_args, ctx) => ctx.ui.notify("shadowed-native-mcp") });
}`);
let ws, browser;
const wire = [];
async function wait(predicate, timeout = 30000) {
 const end = Date.now() + timeout;
 while (Date.now() < end) { const m = wire.find(predicate); if (m) return m; await sleep(20); }
 throw new Error("Timed out: " + predicate + "\n" + harness?.logs.slice(-1500));
}
function send(message) { ws.send(JSON.stringify(message)); }
async function connect() {
 ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
 ws.on("message", raw => { const message = JSON.parse(raw); wire.push(message); state = mergeSnapshot(state, message); });
 await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
 send({ type: "hello", clientId: "extension-ui-test" });
 await wait(m => m.type === "ready");
}
try {
 const env = testEnv({ PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, "data") });
 for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
 harness = await startIsolatedHarness({ env }); PORT = harness.port;
 await connect();
 const a = (await wait(m => m.type === "snapshot")).state.conversationId;
 const file = join(cwd, "attachment.txt"); writeFileSync(file, "literal  attachment");
 const attachments = [{path:file, mode:"inline"}];
 send({type:"prompt",text:"/fixture-retain keep",requestId:"retain-ok",attachments});
 const accepted = await wait(m => m.type === "prompt_result" && m.requestId === "retain-ok");
 assert.equal(accepted.ok,true); assert.notEqual(accepted.attachmentsConsumed,false); assert.equal(accepted.conversationId,a);
 await wait(m => m.type === "notice" && m.text === "retain-call:1");
 send({type:"prompt",text:"/fixture-retain fail",requestId:"retain-fail",attachments});
 assert.equal((await wait(m => m.type === "prompt_result" && m.requestId === "retain-fail")).ok,true);
 await wait(m => m.type === "notice" && m.level === "error");
 assert.equal(wire.filter(m => m.type === "notice" && m.text.startsWith("retain-call:")).length,2);

 send({ type: "prompt", text: "/fixture-ui A" });
 const da = await wait(m => m.type === "dialog" && m.title === "permission-A");
 assert.equal(da.conversationId, a);
 send({ type: "terminal_create", terminalId: "fixture-terminal", cwd, cols: 80, rows: 24, conversationId: a });
 await wait(m => m.type === "terminal_list" && m.terminals.length > 0);
 send({ type: "new_chat" });
 const b = (await wait(m => m.type === "snapshot" && m.state.conversationId !== a)).state.conversationId;
 send({ type: "prompt", text: "/fixture-ui B" });
 const db = await wait(m => m.type === "dialog" && m.title === "permission-B"); assert.notEqual(db.id, da.id);
 send({ type: "dialog_response", conversationId: a, id: da.id, value: true });
 send({ type: "dialog_response", conversationId: b, id: da.id, value: true });
 send({ type: "dialog_response", id: db.id, value: true });
 await sleep(150); assert(!wire.some(m => m.type === "dialog_closed" && [da.id, db.id].includes(m.id)));
 send({ type: "dialog_response", conversationId: b, id: db.id, value: false });
 await wait(m => m.type === "notice" && m.text === "answer-B:false");
 wire.length = 0; ws.close(); await sleep(100); await connect();
 assert.equal((await wait(m => m.type === "dialog")).id, da.id);
 await sleep(100); assert(!wire.some(m => m.type === "dialog" && m.id === db.id));
 send({ type: "switch_conversation", id: a });
 await wait(m => m.type === "snapshot" && m.state.conversationId === a);
 send({ type: "dialog_response", conversationId: a, id: da.id, value: true });
 await wait(m => m.type === "notice" && m.text === "answer-A:true");
 send({ type: "set_run_settings", conversationId: a, autoCompaction: false, autoRetry: false });
 await wait(m => ["snapshot", "snapshot_delta"].includes(m.type) && m.state.runSettings?.autoRetry === false);
 send({ type: "prompt", text: "/fixture-timeout" }); await wait(m => m.type === "notice" && m.text === "timeout:undefined");
 const assertRunSettings = (state, enabled) => {
  assert.equal(state.runSettings.autoCompaction, enabled);
  assert.equal(state.runSettings.autoRetry, enabled);
 };
 for (const [message, matches] of [
  [{ type: "set_thinking", level: "high" }, state => state.thinkingLevel === "high"],
  [{ type: "set_model", modelId: "fixture/fixture-alt" }, state => state.model?.id === "fixture-alt"],
 ]) {
  wire.length = 0; send(message);
  const updated = await wait(m => ["snapshot", "snapshot_delta"].includes(m.type) && m.state.conversationId === a && matches(m.state));
  assertRunSettings(updated.state, false);
  assert(!wire.some(m => m.type === "notice" && m.level === "error"));
 }
 wire.length = 0; ws.close(); await sleep(100); await connect(); send({ type: "get_state" });
 assertRunSettings((await wait(m => m.type === "snapshot" && m.state.conversationId === a)).state, false);
 wire.length = 0; send({ type: "switch_conversation", id: b });
 assertRunSettings((await wait(m => m.type === "snapshot" && m.state.conversationId === b)).state, true);
 send({ type: "prompt", text: "/fixture-timeout" }); await wait(m => m.type === "notice" && m.text === "timeout:undefined");
 wire.length = 0; send({ type: "switch_conversation", id: a });
 assertRunSettings((await wait(m => m.type === "snapshot" && m.state.conversationId === a)).state, false);
 send({ type: "prompt", text: "/fixture-ui reload" }); const old = await wait(m => m.type === "dialog" && m.title === "permission-reload");
 await wait(() => !state.isStreaming); wire.length = 0; send({ type: "extensions_reload" }); await wait(m => m.type === "dialog_closed" && m.id === old.id);
 const reloadedSettings = await wait(m => m.type === "settings_state");
 // Settings are published before the reload lease is released; only the later idle snapshot permits input.
 await wait(m => ["snapshot", "snapshot_delta"].includes(m.type) && wire.indexOf(m) > wire.indexOf(reloadedSettings) && m.state.conversationId === a && m.state.isStreaming === false);
 send({ type: "prompt", text: "/mcp list", requestId: "native-mcp" });
 const mcpReceipt = await wait(m => m.type === "prompt_result" && m.requestId === "native-mcp");
 assert.equal(mcpReceipt.commandExecuted, true, JSON.stringify(mcpReceipt));
 assert(!wire.some(m => m.type === "notice" && m.text === "shadowed-native-mcp"), "native builtin precedence is preserved");
 send({ type: "prompt", text: "/fixture-mcp" }); await wait(m => m.type === "notice" && m.text === "third-party-mcp");
 send({ type: "prompt", text: "/fixture-ui after-reload" }); const after = await wait(m => m.type === "dialog" && m.title === "permission-after-reload");
 assert.notEqual(after.id, old.id);
 send({ type: "dialog_response", conversationId: a, id: old.id, value: true });
 send({ type: "dialog_response", conversationId: a, id: after.id, value: false });
 await wait(m => m.type === "notice" && m.text === "answer-after-reload:false");
 wire.length = 0; send({ type: "get_state" });
 assertRunSettings((await wait(m => m.type === "snapshot" && m.state.conversationId === a)).state, false);
 const persisted = JSON.parse(readFileSync(join(agent, "config.yml"), "utf8"));
 assert.equal(persisted.compaction.enabled, true); assert.equal(persisted.retry.enabled, true);
 assert.equal(persisted.defaultTools, undefined);
 assert.equal(persisted.cacheWarming.enabled, false);

 if (process.argv.includes("--browser")) {
  browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  const page = await browser.newPage();
  let browserSocket, snapshot; const sent = [], received = [];
  await page.routeWebSocket("**/ws", route => {
   browserSocket = route; const upstream = route.connectToServer();
   route.onMessage(raw => { const m = JSON.parse(String(raw)); sent.push(m); if (m.type !== "cancel_recovery") upstream.send(raw); });
   upstream.onMessage(raw => { const m = JSON.parse(String(raw)); received.push(m); snapshot = mergeSnapshot(snapshot, m); route.send(raw); });
  });
  await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "extension-ui-test"));
  await page.goto(`http://127.0.0.1:${PORT}`);
  await page.waitForSelector(".inputbox textarea");
  const composer = page.locator(".inputbox textarea");
  await page.locator('.inputbox input[type="file"]').setInputFiles({name:"retain.txt",mimeType:"text/plain",buffer:Buffer.from("frozen upload")});
  await composer.fill("/fixture-retain"); await page.locator(".composer-action.send").click();
  await page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value === "" && document.querySelectorAll(".attach-chip.file").length === 0);
  assert.equal(await composer.inputValue(), ""); assert.equal(await page.locator(".attach-chip.file").count(), 0);
  await composer.fill("/fixture-retain fail"); await page.locator(".composer-action.send").click(); await sleep(650);
  assert.equal(await composer.inputValue(), ""); assert.equal(await page.locator(".attach-chip.file").count(), 0);
  await composer.fill("/fixture-retain"); await page.locator(".composer-action.send").click(); await composer.fill("new draft");
  await page.locator('.inputbox input[type="file"]').setInputFiles({name:"new.txt",mimeType:"text/plain",buffer:Buffer.from("new upload")});
  await sleep(650); assert.equal(await composer.inputValue(), "new draft"); assert.equal(await page.locator(".attach-chip.file").count(), 1);
  assert(received.some(m => m.type === "notice" && m.text === "retain-upload:true"), "uploaded attachment reaches the native handler");
  send({ type: "prompt", text: "/fixture-editor" });
  await page.waitForSelector('[data-dialog-kind="editor"] textarea');
  assert.equal(await page.locator('[data-dialog-kind="editor"] textarea').inputValue(), "first\nsecond");
  await page.locator('[data-dialog-kind="editor"] textarea').fill("edited\nmultiline");
  await page.locator('[data-dialog-kind="editor"] .primary').click();
  await page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value === "edited\nmultiline");
  send({ type: "prompt", text: "/fixture-ui browser-A" });
  const prompt = await wait(m => m.type === "dialog" && m.title === "permission-browser-A");
  send({ type: "switch_conversation", id: b });
  await page.waitForFunction(() => !document.querySelector('[data-dialog-kind="confirm"]'));
  await page.getByRole("button", { name: /permission-browser-A/ }).click();
  await page.waitForSelector('[data-dialog-kind="confirm"]');
  assert.equal(await page.title(), "title-browser-A");
  send({ type: "dialog_response", conversationId: a, id: prompt.id, value: false });
  await page.locator('[data-dialog-kind="confirm"]').waitFor({ state: "hidden" });
  const beforeRetry = sent.filter(m => m.type === "retry_silent_prompt").length;
  const recoveryState = { ...snapshot, rev: snapshot.rev + 1, isStreaming: true, messages: [{ id: "recovery-user", role: "user", timestamp: Date.now() - 240000, content: [{ type: "text", text: "fixture" }] }], recovery: { compaction: { id: "long-compaction", reason: "overflow" }, summary: { id: "summary-retry", source: "compaction", phase: "waiting", attempt: 2, maxAttempts: 3, remainingMs: 10000, error: "529 overload" } } };
  browserSocket.send(JSON.stringify({ type: "snapshot", state: recoveryState }));
  await page.getByText(/等待摘要重试/).waitFor();
  assert.equal(await page.locator(".waiting-header-status").count(), 0);
  await page.locator('.agent-silence button', { hasText: "取消" }).click();
  assert(sent.some(m => m.type === "cancel_recovery" && m.operationId === "summary-retry" && m.conversationId === a));
  assert.equal(sent.filter(m => m.type === "retry_silent_prompt").length, beforeRetry);
  browserSocket.send(JSON.stringify({ type: "snapshot", state: { ...recoveryState, rev: recoveryState.rev + 1, recovery: { compaction: recoveryState.recovery.compaction } } }));
  await page.locator(".compaction-status .running-indicator").waitFor();
  await page.locator(".compaction-status").getByText("正在压缩", { exact: true }).waitFor();
  assert.equal(await page.locator(".agent-silence").count(), 0);
  await page.locator(".compaction-status button").click();
  assert(sent.some(m => m.type === "cancel_recovery" && m.operationId === "long-compaction" && m.conversationId === a));
  browserSocket.send(JSON.stringify({ type: "snapshot", state: { ...snapshot, rev: recoveryState.rev + 2, recovery: {} } }));
  await page.getByText(/正在压缩/).waitFor({ state: "hidden" });
  browserSocket.send(JSON.stringify({ type: "snapshot", state: { ...snapshot, rev: recoveryState.rev + 3, recovery: { lastCompaction: { id: "completed", reason: "manual", status: "completed", tokensBefore: 8000, tokensAfter: 400 } } } }));
  await page.getByText(/压缩完成/).waitFor({ state: "hidden" });
  assert.equal(await page.locator(".compaction-status").count(), 0);
  browserSocket.send(JSON.stringify({ type: "snapshot", state: { ...snapshot, rev: recoveryState.rev + 4, recovery: { lastCompaction: { id: "failed", reason: "manual", status: "error", error: "fixture compaction error" } } } }));
  await page.getByText(/fixture compaction error/).waitFor();
  await page.locator('.agent-silence button', { hasText: "关闭" }).click();
  await page.getByText(/fixture compaction error/).waitFor({ state: "hidden" });
 }
 console.log("PASS native extension UI isolation, validation, reconnect, timeout, reload, custom command and memory settings" + (browser ? ", browser multiline editor, background navigation and recovery phases" : ""));
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
 await browser?.close(); ws?.close();
 await harness?.stop();
 rmSync(root, { recursive: true, force: true });
}
