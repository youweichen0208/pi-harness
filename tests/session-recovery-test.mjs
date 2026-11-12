// Native missing-cwd recovery through the real WebSocket routes; no external model calls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-session-recovery-"));
const cwd = join(root, "current"), old = join(root, "removed"), agent = join(root, "agent"), data = join(root, "data");
mkdirSync(cwd); mkdirSync(old); mkdirSync(agent);
const original = SessionManager.create(old, join(agent, "sessions", "orphan"));
const first = original.appendMessage({ role: "user", content: "Recovered first question", timestamp: Date.now() });
original.appendMessage({ role: "user", content: "Original branch", timestamp: Date.now() + 1 });
original.branch(first);
original.appendMessage({ role: "user", content: "Alternative branch", timestamp: Date.now() + 2 });
original.appendLabelChange(first, "keep-label");
original.appendSessionInfo("Missing project history");
const originalPath = original.getSessionFile(), originalBytes = readFileSync(originalPath), originalEntries = original.getEntries();
const valid = SessionManager.create(cwd, join(agent, "sessions", "valid"));
valid.appendMessage({ role: "user", content: "Current project history", timestamp: Date.now() });
rmSync(old, { recursive: true });
const heldResponses = [];
const mock = createServer(async (req, res) => {
	for await (const _chunk of req) { /* Drain prompt. */ }
	res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); heldResponses.push(res);
});
let harness, browser;
const clients = [];
const entries = path => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
const fileCount = () => readdirSync(join(agent, "sessions"), { recursive: true }).filter(path => path.endsWith(".jsonl")).length;
const wait = async (predicate, timeout = 15000) => {
	const until = Date.now() + timeout;
	while (Date.now() < until) { const value = await predicate(); if (value) return value; await sleep(20); }
	throw Error(`Timeout: ${predicate}\n${harness?.logs.slice(-2000)}`);
};
async function connect(id, wikiCwd) {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`), client = { ws, messages: [], state: null, sequence: 0 };
	clients.push(client);
	ws.on("message", raw => { const message = JSON.parse(raw); client.messages.push(message); if (message.type === "snapshot") client.state = message.state; if (message.type === "snapshot_delta" && client.state) client.state = { ...client.state, ...message.state, messages: [...client.state.messages, ...message.appended] }; });
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	client.send = message => ws.send(JSON.stringify(message));
	client.send({ type: "hello", clientId: id, wikiCwd });
	client.send({ type: "get_state" });
	await wait(() => client.state);
	client.request = async (type, fields = {}) => {
		const reqId = `${id}-${++client.sequence}`;
		client.send({ type, reqId, conversationId: client.state.conversationId, ...fields });
		return wait(() => client.messages.find(message => message.reqId === reqId));
	};
	client.list = () => client.request("list_missing_sessions");
	client.recover = (token, action) => client.request("recover_missing_session", { token, action });
	return client;
}
try {
	const mockPort = await listenIsolated(mock);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "unused", models: [{ id: "recovery", reasoning: false, contextWindow: 64000, maxTokens: 1024, input: ["text"] }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "recovery", retry: { enabled: false }, compaction: { enabled: false }, defaultTools: { codemode: false, toolSearch: false, subagents: false } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent } });
	const client = await connect("recovery-test");
	assert(!client.messages.some(message => message.type === "missing_sessions"), "recovery listing must remain lazy");
	let listing = await client.list();
	assert.equal(listing.sessions.length, 1); assert.equal(listing.sessions[0].cwd, old);
	assert.equal((await client.recover("forged", "fork")).status, "error");
	const beforeCancel = fileCount(), currentId = client.state.conversationId;
	assert.equal((await client.recover(listing.sessions[0].token, "cancel")).status, "cancelled");
	assert.equal(fileCount(), beforeCancel); assert.equal(client.state.conversationId, currentId);
	assert.equal((await client.recover(listing.sessions[0].token, "fork")).status, "error", "cancelled selection cannot be reused");
	listing = await client.list();
	const stale = listing.sessions[0].token;
	client.send({ type: "switch_session", path: valid.getSessionFile() }); await wait(() => client.state.conversationId !== currentId);
	assert.equal((await client.recover(stale, "fork")).status, "error", "selection belongs to its original conversation");
	listing = await client.list();
	const beforeContinue = fileCount();
	assert.equal((await client.recover(listing.sessions[0].token, "continue")).status, "ok");
	await wait(() => client.state.sessionFile === originalPath);
	assert.equal(client.state.cwd, cwd); assert.equal(entries(originalPath)[0].cwd, old); assert.equal(fileCount(), beforeContinue);
	// SDK may append model settings on open; the original header and pre-existing tree stay intact.
	assert.deepEqual(entries(originalPath).slice(0, originalEntries.length + 1), JSON.parse(`[${originalBytes.toString().trim().split("\n").join(",")}]`));
	const continuedId = client.state.conversationId;
	client.send({ type: "new_chat" }); await wait(() => client.state.conversationId !== continuedId);
	listing = await client.list(); assert.equal(listing.sessions.length, 1, "Continue does not persist a cwd override");
	// Run work in the current conversation while independently opening a recovered copy.
	client.send({ type: "prompt", text: "keep this request running" });
	await wait(() => client.state.isStreaming && heldResponses.length);
	const runningId = client.state.conversationId;
	const beforeFork = readFileSync(originalPath), forkSource = entries(originalPath);
	assert.equal((await client.recover(listing.sessions[0].token, "fork")).status, "ok");
	await wait(() => client.state.conversationId !== runningId);
	const forkPath = client.state.sessionFile, copied = entries(forkPath);
	assert.notEqual(forkPath, originalPath); assert.notEqual(copied[0].id, forkSource[0].id);
	assert.equal(copied[0].cwd, cwd); assert.equal(copied[0].parentSession, originalPath);
	assert.deepEqual(copied.slice(1, forkSource.length), forkSource.slice(1));
	assert.deepEqual(readFileSync(originalPath), beforeFork);
	assert(client.messages.filter(message => message.type === "conversations").at(-1).conversations.some(conv => conv.id === runningId && conv.isStreaming), "opening recovered history must not abort background work");
	client.send({ type: "switch_conversation", id: runningId }); await wait(() => client.state.conversationId === runningId);
	client.send({ type: "abort" }); await wait(() => !client.state.isStreaming);
	// File mutation invalidates a token rather than opening a different or stale transcript.
	listing = await client.list();
	writeFileSync(originalPath, Buffer.concat([readFileSync(originalPath), Buffer.from("\n")]));
	assert.equal((await client.recover(listing.sessions[0].token, "fork")).status, "error");
	const wiki = await connect("recovery-wiki", cwd);
	assert.match((await wiki.list()).error, /知识库/);
	assert.equal((await wiki.recover("forged", "fork")).status, "error");
	// Lost source and lost target are rejected without creating new transcripts.
	listing = await client.list(); const count = fileCount();
	rmSync(originalPath);
	assert.equal((await client.recover(listing.sessions[0].token, "continue")).status, "error"); assert.equal(fileCount(), count - 1);
	writeFileSync(originalPath, originalBytes);
	listing = await client.list();
	rmSync(cwd, { recursive: true });
	assert.equal((await client.recover(listing.sessions[0].token, "fork")).status, "error"); mkdirSync(cwd);
	if (process.argv.includes("--browser")) {
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
		await page.goto(`http://127.0.0.1:${harness.port}`);
		const toggle = page.getByRole("button", { name: "原目录已失效的会话", exact: true });
		await toggle.waitFor(); await wait(() => toggle.isEnabled());
		assert.equal(await toggle.getAttribute("aria-expanded"), "false");
		await toggle.click(); await page.getByRole("button", { name: "Missing project history" }).click();
		const dialog = page.getByRole("dialog", { name: "在当前项目恢复会话" });
		await dialog.waitFor(); assert(await dialog.getByText(old, { exact: true }).isVisible());
		await dialog.getByRole("button", { name: "复制到当前项目", exact: true }).focus();
		await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
		await toggle.click(); await page.getByRole("button", { name: "Missing project history" }).click();
		await dialog.getByRole("button", { name: "复制到当前项目", exact: true }).click();
		await dialog.waitFor({ state: "hidden" });
		assert(await toggle.isVisible());
		await page.setViewportSize({ width: 390, height: 844 });
		// Capture the reusable recovery modal at a narrow viewport for visual inspection.
		await page.setViewportSize({ width: 1280, height: 850 });
		await toggle.click(); await page.getByRole("button", { name: "Missing project history" }).click();
		await page.setViewportSize({ width: 390, height: 844 });
		assert((await dialog.boundingBox()).width <= 390);
		assert.notEqual(await dialog.getByRole("button", { name: "取消", exact: true }).evaluate(button => getComputedStyle(button).backgroundColor), await dialog.getByRole("button", { name: "复制到当前项目", exact: true }).evaluate(button => getComputedStyle(button).backgroundColor), "only Copy is the primary action");
		mkdirSync("tests/scratch", { recursive: true }); await page.screenshot({ path: "tests/scratch/session-recovery-mobile.png" });
		await page.keyboard.press("Escape");
		await page.evaluate(() => { localStorage.setItem("pi-harness:lang", "en"); localStorage.setItem("pi-harness:theme", "graphite"); localStorage.setItem("pi-harness:theme-follow", "0"); });
		await page.setViewportSize({ width: 1280, height: 850 }); await page.reload();
		const englishToggle = page.getByRole("button", { name: "Sessions with missing folders", exact: true });
		await wait(() => englishToggle.isEnabled()); await englishToggle.click();
		await page.getByRole("button", { name: "Missing project history" }).click();
		const englishDialog = page.getByRole("dialog", { name: "Restore in the current project" });
		await englishDialog.waitFor(); await page.screenshot({ path: "tests/scratch/session-recovery-dark-en.png" });
		await englishDialog.getByRole("button", { name: "Cancel", exact: true }).click(); await englishDialog.waitFor({ state: "hidden" });
	}
	for (const connected of clients) connected.ws.close();
	await harness.stop();
	// Startup cannot invent a usable directory when both remembered and configured cwd are gone.
	rmSync(cwd, { recursive: true });
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent } });
	const bad = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`), notices = [];
	clients.push({ ws: bad }); bad.on("message", raw => notices.push(JSON.parse(raw)));
	await new Promise(resolve => bad.once("open", resolve)); bad.send(JSON.stringify({ type: "hello", clientId: "invalid-cwd" }));
	await wait(() => notices.find(message => message.type === "notice" && message.text.includes("--cwd <有效目录>")));
	console.log("PASS missing-cwd recovery: lazy discovery, bound selections, cancel/continue/full-tree copy, background run preservation, changed/deleted files, missing target, Wiki isolation, startup guidance" + (browser ? "; browser actions and narrow modal" : ""));
} finally {
	await browser?.close();
	for (const client of clients) client.ws.terminate();
	for (const response of heldResponses) response.destroy();
	mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	await harness?.stop();
	rmSync(root, { recursive: true, force: true });
}
