/** Switching projects must also change the owner of every new-chat entry point. */
import { createOmpHistory } from "./lib/omp-history-fixture.mjs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
const root = mkdtempSync(join(tmpdir(), "pi-project-new-chat-"));
const projects = ["project-1", "project-2"].map(name => join(root, name));
let existingHistory;
for (const p of projects) {
	mkdirSync(p);
	if (p === projects[1]) existingHistory = await createOmpHistory({ dataDir: join(root, "data"), cwd: p, messages: [{ role: "user", content: "Existing conversation", timestamp: Date.now() }] });
}
let harness, socket, browser;
async function wait(predicate, label) {
	for (let i = 0; i < 1200; i++) { if (predicate()) return; await delay(25); }
	throw Error(`Timeout: ${label}\n${harness?.logs}`);
}
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: projects[0], PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent") } });
	socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	const messages = [];
	socket.on("message", raw => messages.push(JSON.parse(raw)));
	await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
	const send = message => socket.send(JSON.stringify(message));
	send({ type: "hello", clientId: "project-setup" });
	await wait(() => messages.some(m => m.type === "ready"), "setup ready");
	send({ type: "project_workspace_action", revision: 0, requestId: "create", action: { kind: "create", name: "Work" } });
	await wait(() => messages.some(m => m.requestId === "create"), "workspace created");
	const id = messages.find(m => m.requestId === "create").workspaceId;
	for (const [index, path] of projects.entries()) {
		send({ type: "project_workspace_action", revision: index + 1, requestId: `add-${index}`, action: { kind: "add", id, path } });
		await wait(() => messages.some(m => m.requestId === `add-${index}`), "project added");
		assert(messages.find(m => m.requestId === `add-${index}`).ok);
	}
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage();
	await page.addInitScript(() => {
		const NativeSocket = window.WebSocket;
		window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); window.ompTestSocket = this; } };
	});
	let state, snapshots = 0; const outgoing = [];
	page.on("websocket", ws => {
		ws.on("framesent", ({ payload }) => outgoing.push(JSON.parse(String(payload))));
		ws.on("framereceived", ({ payload }) => {
			const m = JSON.parse(String(payload));
			if (m.type === "snapshot") { state = m.state; snapshots++; }
			if (m.type === "snapshot_delta") { state = { ...state, ...m.state }; snapshots++; }
		});
	});
	await page.goto(`http://127.0.0.1:${harness.port}`);
	await page.locator(".setup-modal .modal-close").click();
	await page.locator(`.project-item.active[title=${JSON.stringify(projects[0])}]`).waitFor();
	const projectOneConversation = state.conversationId;
	await page.locator(`.project-item[title=${JSON.stringify(projects[1])}]`).click();
	await page.locator(`.project-item.active[title=${JSON.stringify(projects[1])}]`).waitFor();
	await wait(() => state?.cwd === projects[1] && !state.isStreaming && state.sessionFile, "project-2 authoritative snapshot");
	await page.evaluate(path => window.ompTestSocket.send(JSON.stringify({ type: "switch_session", path })), existingHistory.sessionFile);
	await wait(() => state?.sessionFile === existingHistory.sessionFile && !state.isStreaming, "existing OMP conversation opened");
	const oldConversation = state.conversationId;
	await page.locator(".lp-project-new").click();
	await wait(() => outgoing.some(m => m.type === "new_chat"), "new-chat request");
	await wait(() => state.conversationId !== oldConversation && !state.isStreaming && state.sessionFile, "new conversation committed");
	assert.deepEqual(outgoing.filter(m => m.type === "set_cwd").map(m => m.path), [projects[1]], "Browser must not navigate back to project-1");
	assert.equal(state.cwd, projects[1], "New chat after selecting project-2 must belong to project-2, not project-1");
	assert.equal(state.sessionFile?.includes(createHash("sha256").update(realpathSync(projects[1])).digest("hex").slice(0, 24)), true, `New session file must belong to project-2: ${state.sessionFile}`);
	const newConversation = state.conversationId;
	const before = snapshots;
	await page.locator(".global-new-chat").click();
	await wait(() => snapshots > before, "repeated new-chat snapshot");
	assert.equal(state.cwd, projects[1]);
	assert.equal(state.conversationId, newConversation, "Repeated new chat reuses the current project's blank");
	await page.locator(`.project-item[title=${JSON.stringify(projects[0])}]`).click();
	await wait(() => state.cwd === projects[0], "return to project-1");
	assert.equal(state.conversationId, projectOneConversation, "The other project's blank remains independently available");
	console.log("PASS project switch/new chat ownership, same-project blank reuse and other-project isolation");
} finally {
	await browser?.close(); socket?.close(); await harness?.stop(); rmSync(root, { recursive: true, force: true });
}
