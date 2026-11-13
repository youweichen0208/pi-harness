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
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { testEnv } from "./lib/test-env.mjs";

const PORT = 8968;
const base = mkdtempSync(join(tmpdir(), "pi-web-delete-session-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
const sessionsDir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
mkdirSync(sessionsDir, { recursive: true });

const seed = (id, text) => {
	const path = join(sessionsDir, `2026-10-19T00-00-0${id === "A" ? 0 : 1}-000Z_${id}.jsonl`);
	writeFileSync(path, [
		{ type: "session", version: 3, id, timestamp: "2026-10-19T00:00:00.000Z", cwd: workdir },
		{ type: "message", id: `user-${id}`, parentId: null, timestamp: "2026-10-19T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } },
	].map((row) => JSON.stringify(row)).join("\n") + "\n");
	return path;
};
const sessionA = seed("A", "EXITED_TERMINAL_SESSION");
const sessionB = seed("B", "LIVE_TERMINAL_SESSION");

const repoRoot = realpathSync(new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...testEnv(),
		PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 20000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

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
	async waitForType(type, predicate = () => true, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const index = this.received.findIndex((message) => message.type === type && predicate(message));
			if (index >= 0) return this.received.splice(index, 1)[0];
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
}

let client;
let passed = 0;
const check = (name, condition) => {
	assert.ok(condition, name);
	passed++;
	console.log(`  ✓ ${name}`);
};

try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
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
	await client.waitForState((state) => state.sessionFile !== sessionA);
	client.send({ type: "delete_session", path: sessionA });
	await client.waitForType("sessions", () => true);
	const warning = client.received.find((message) => message.type === "notice" && message.level === "warning");
	check("exited terminal no longer blocks deletion", !warning);
	check("session A transcript deleted from disk", !existsSync(sessionA));

	// -- session B: live terminal --------------------------------------------
	client.send({ type: "switch_session", path: sessionB });
	await client.waitForState((state) => state.sessionFile === sessionB);
	const terminalB = "term-live";
	client.send({ type: "terminal_create", terminalId: terminalB, cwd: workdir, cols: 60, rows: 16 });
	const liveList = await client.waitForType("terminal_list", (message) => message.terminals.some((item) => item.id === terminalB && item.running));
	const liveTitle = liveList.terminals.find((item) => item.id === terminalB).title;
	client.send({ type: "new_chat" });
	await client.waitForState((state) => state.sessionFile !== sessionB);
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

	console.log(`\n${passed} checks passed`);
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	client?.ws.close();
	server.kill("SIGTERM");
}
