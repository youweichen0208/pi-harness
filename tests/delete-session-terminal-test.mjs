/**
 * delete_session vs. terminal ownership.
 *
 * A conversation stays warm after the user switches away whenever it still owns
 * a terminal, so a session can be "in use" by a background conversation the
 * user cannot see. Rules under test:
 *   1. an EXITED terminal (scrollback only, nothing running) must NOT block
 *      deleting the session — the tab cannot be closed from the current
 *      conversation, so blocking would lock the session forever;
 *   2. a LIVE terminal still blocks, and the notice names the terminal;
 *   3. the active conversation is always refused with its own message.
 *
 * Usage: npm run build && node tests/delete-session-terminal-test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
import { createOmpHistory } from "./lib/omp-history-fixture.mjs";

const base = mkdtempSync(join(tmpdir(), "omp-delete-session-"));
const workdir = join(base, "work"), dataDir = join(base, "data"), agentDir = join(dataDir, "omp/agent");
for (const path of [workdir, agentDir]) mkdirSync(path, { recursive: true });
writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
let harness, sessionA, sessionB;

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (
				message.type === "snapshot_delta" &&
				this.state &&
				this.state.rev === message.baseRev &&
				message.conversationId === this.state.conversationId
			) this.state = { ...this.state, ...message.state };
		});
	}
	send(message) { this.ws.send(JSON.stringify(message)); }
	async waitForType(type, predicate = () => true, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const index = this.received.findIndex((message) => message.type === type && predicate(message));
			if (index >= 0) return this.received.splice(index, 1)[0];
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
}

let client, otherClient;
let passed = 0;
const check = (name, condition) => {
	assert.ok(condition, name);
	passed++;
	console.log(`  ✓ ${name}`);
};

try {
	sessionA = (await createOmpHistory({ dataDir, cwd: workdir, messages: [{ role: "user", content: "EXITED_TERMINAL_SESSION", timestamp: Date.now() }] })).sessionFile;
	sessionB = (await createOmpHistory({ dataDir, cwd: workdir, messages: [{ role: "user", content: "LIVE_TERMINAL_SESSION", timestamp: Date.now() }] })).sessionFile;
	harness = await startIsolatedHarness({ ...(process.argv.includes("--source") ? { args: ["--import", "tsx", "server/index.ts"] } : {}), env: { PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: workdir } });
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	client = new Client(ws);
	client.send({ type: "hello", clientId: "delete-session-terminal-test" });
	await client.waitForType("ready");
	await client.waitForState((state) => Boolean(state.conversationId));

	// -- session A: terminal that already exited ------------------------------
	client.send({ type: "switch_session", path: sessionA });
	await client.waitForState((state) => state.sessionFile === sessionA);
	const terminalA = "term-exited";
	client.send({ type: "terminal_create", terminalId: terminalA, cwd: workdir, cols: 60, rows: 16 });
	await client.waitForType("terminal_list", (message) => message.terminals.some((item) => item.id === terminalA));
	client.send({ type: "terminal_input", terminalId: terminalA, data: "exit\r" });
	await client.waitForType("terminal_exit", (message) => message.terminalId === terminalA);
	await client.waitForType("terminal_list", (message) => message.terminals.some((item) => item.id === terminalA && !item.running));
	check("exited terminal is retained with running=false", true);

	// Switching away keeps the conversation warm because it owns a terminal, so
	// the transcript is owned by a BACKGROUND conversation when we delete it.
	client.send({ type: "new_chat" });
	await client.waitForState((state) => state.sessionFile !== sessionA && !state.isStreaming);
	const artifactsA = sessionA.slice(0, -6), backupA = `${sessionA}.fixture.bak`;
	mkdirSync(artifactsA, { recursive: true }); writeFileSync(join(artifactsA, "tool-output.log"), "native artifact fixture");
	writeFileSync(backupA, readFileSync(sessionA));
	client.send({ type: "delete_session", path: sessionA });
	await client.waitForType("sessions", message => !message.sessions.some(session => session.path === sessionA));
	const warning = client.received.find((message) => message.type === "notice" && message.level === "warning");
	check("exited terminal no longer blocks deletion", !warning);
	check("session A transcript deleted from disk", !existsSync(sessionA));
	check("native artifacts and rewrite backups are removed", !existsSync(artifactsA) && !existsSync(backupA));

	// -- session B: live terminal --------------------------------------------
	client.send({ type: "switch_session", path: sessionB });
	await client.waitForState((state) => state.sessionFile === sessionB);
	const terminalB = "term-live";
	client.send({ type: "terminal_create", terminalId: terminalB, cwd: workdir, cols: 60, rows: 16 });
	const liveList = await client.waitForType("terminal_list", (message) => message.terminals.some((item) => item.id === terminalB && item.running));
	const liveTitle = liveList.terminals.find((item) => item.id === terminalB).title;
	client.send({ type: "new_chat" });
	await client.waitForState((state) => state.sessionFile !== sessionB && !state.isStreaming);
	client.send({ type: "delete_session", path: sessionB });
	const liveWarning = await client.waitForType("notice", (message) => message.level === "warning");
	check("live terminal refuses deletion", liveWarning.text.includes("运行中的终端"));
	check("warning names the terminal", liveWarning.text.includes(liveTitle));
	check("session B transcript kept", existsSync(sessionB));

	// -- active conversation is refused with its own message ------------------
	client.send({ type: "switch_session", path: sessionB });
	await client.waitForState((state) => state.sessionFile === sessionB);
	client.send({ type: "delete_session", path: sessionB });
	const activeWarning = await client.waitForType("notice", (message) => message.level === "warning");
	check("active conversation is refused", activeWarning.text.includes("正在使用中"));
	check("session B still on disk", existsSync(sessionB));

	// A different live client owns this transcript; deleting it must not stop
	// or invalidate that window, even when its model is currently idle.
	const sessionC = (await createOmpHistory({ dataDir, cwd: workdir, messages: [{ role: "user", content: "OTHER_WINDOW_SESSION", timestamp: Date.now() }] })).sessionFile;
	const otherSocket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	await new Promise((resolve, reject) => { otherSocket.once("open", resolve); otherSocket.once("error", reject); });
	otherClient = new Client(otherSocket);
	otherClient.send({ type: "hello", clientId: "delete-session-other-window" });
	await otherClient.waitForType("ready");
	await otherClient.waitForState(state => state.sessionFile === sessionC && !state.isStreaming);
	client.send({ type: "delete_session", path: sessionC });
	const ownedWarning = await client.waitForType("notice", message => message.level === "warning");
	check("another window's idle history is protected", ownedWarning.text.includes("其他窗口") && existsSync(sessionC));
	otherClient.received = otherClient.received.filter(message => message.type !== "snapshot");
	otherClient.send({ type: "get_state" });
	await otherClient.waitForType("snapshot", message => message.state.sessionFile === sessionC && !message.state.sessionPersistence?.failed);
	check("other window remains readable", true);

	console.log(`\n${passed} checks passed`);
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	client?.ws.terminate(); otherClient?.ws.terminate();
	await harness?.stop();
	rmSync(base, { recursive: true, force: true });
}
