/**
 * delete_session vs. terminal ownership.
 *
 * Terminals belong to the PROJECT WORKSPACE, not to a conversation, so deleting
 * a chat is pure session bookkeeping and must never disturb a running shell.
 * Rules under test:
 *   1. a LIVE terminal survives deleting the background session that created it
 *      — no warning, no 15s confirm window, PTY still running and echoing;
 *   2. a LIVE terminal also survives deleting the ACTIVE session (the server
 *      still leaves it first, but only the runtime/transcript goes away);
 *   3. deleting the last conversation of a project keeps its terminals: coming
 *      back to that project lists them again and they are still running;
 *   4. an EXITED terminal keeps its scrollback and never blocks anything.
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
const sessionsDirFor = (cwd) => join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

const seed = (id, text, cwd = workdir) => {
	const dir = sessionsDirFor(cwd);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `2026-10-19T00-00-0${id === "A" ? 0 : 1}-000Z_${id}.jsonl`);
	writeFileSync(path, [
		{ type: "session", version: 3, id, timestamp: "2026-10-19T00:00:00.000Z", cwd },
		{ type: "message", id: `user-${id}`, parentId: null, timestamp: "2026-10-19T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } },
	].map((row) => JSON.stringify(row)).join("\n") + "\n");
	return path;
};
const sessionA = seed("A", "FIRST_TERMINAL_SESSION");
const sessionB = seed("B", "SECOND_TERMINAL_SESSION");

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
	/** Create a terminal in the ACTIVE workspace and wait until it is live. */
	async createTerminal(terminalId, cwd) {
		this.send({ type: "terminal_create", terminalId, cwd, cols: 60, rows: 16 });
		return this.waitForType("terminal_list", (message) => message.terminals.some((item) => item.id === terminalId && item.running));
	}
	/** Assert the PTY is actually alive: it must echo a marker back. */
	async expectAlive(terminalId, marker) {
		this.send({ type: "terminal_input", terminalId, data: `echo ${marker}\r` });
		await this.waitForType("terminal_output", (message) => message.terminalId === terminalId && message.data.includes(marker));
	}
	/** Switch to another project and back, so the server re-pushes the list. */
	async roundTripProject(dir) {
		this.send({ type: "set_cwd", path: base, source: "ui" });
		await this.waitForState((state) => realpathSync(state.cwd) === realpathSync(base));
		this.send({ type: "set_cwd", path: dir, source: "ui" });
		await this.waitForState((state) => realpathSync(state.cwd) === realpathSync(dir));
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

	// -- 1. deleting the session that created a live terminal ------------------
	client.send({ type: "switch_session", path: sessionA });
	await client.waitForState((state) => state.sessionFile === sessionA);
	const terminalA = "term-live-a";
	await client.createTerminal(terminalA, workdir);
	await client.expectAlive(terminalA, "ALIVE_A");

	client.send({ type: "new_chat" });
	await client.waitForState((state) => state.sessionFile !== sessionA);
	client.send({ type: "delete_session", path: sessionA });
	await client.waitForType("sessions", () => true);
	const blockA = client.received.find((message) =>
		message.type === "notice" && message.level === "warning" && /终端|正在使用中|后台任务/.test(message.text));
	check("a live terminal no longer blocks deleting its session", !blockA);
	check("session A transcript deleted from disk", !existsSync(sessionA));

	// The PTY must have survived the delete: still listed after re-entering the
	// project, still running, and still echoing input.
	await client.roundTripProject(workdir);
	const listAfterA = await client.waitForType("terminal_list", (message) =>
		message.terminals.some((item) => item.id === terminalA));
	check("the terminal is still listed after the delete", listAfterA.terminals.some((item) => item.id === terminalA && item.running));
	await client.expectAlive(terminalA, "STILL_A");
	check("and it still echoes input after the delete", true);

	// -- 2. deleting the ACTIVE session that owns a live terminal --------------
	client.send({ type: "switch_session", path: sessionB });
	await client.waitForState((state) => state.sessionFile === sessionB);
	const terminalB = "term-live-b";
	await client.createTerminal(terminalB, workdir);
	await client.expectAlive(terminalB, "ALIVE_B");
	const activeB = client.state.conversationId;
	const markB = client.received.length;
	client.send({ type: "delete_session", path: sessionB });
	await client.waitForState((state) => state.conversationId !== activeB);
	const blockB = client.received.slice(markB).find((message) =>
		message.type === "notice" && /正在使用中|无法离开|仍在运行|仍有后台任务|运行中的终端/.test(message.text));
	check("the active session closes without a terminal warning", !blockB);
	check("session B transcript deleted from disk", !existsSync(sessionB));
	await client.roundTripProject(workdir);
	const listAfterB = await client.waitForType("terminal_list", (message) =>
		message.terminals.some((item) => item.id === terminalB));
	check("its terminal survived too", listAfterB.terminals.some((item) => item.id === terminalB && item.running));
	await client.expectAlive(terminalB, "STILL_B");
	check("and it still echoes input after the delete", true);

	// -- 3. last conversation of a project ------------------------------------
	const soloDir = join(base, "solo");
	mkdirSync(soloDir, { recursive: true });
	const sessionD = seed("D", "SOLO_SESSION", soloDir);
	client.send({ type: "switch_session", path: sessionD });
	await client.waitForState((state) => state.sessionFile === sessionD);
	check("project switched to the solo workspace", realpathSync(client.state.cwd) === realpathSync(soloDir));
	const terminalD = "term-solo";
	await client.createTerminal(terminalD, soloDir);
	await client.expectAlive(terminalD, "ALIVE_D");
	const activeD = client.state.conversationId;
	const markD = client.received.length;
	client.send({ type: "delete_session", path: sessionD });
	await client.waitForState((state) => state.conversationId !== activeD);
	const blockD = client.received.slice(markD).find((message) =>
		message.type === "notice" && /正在使用中|无法离开|仍在运行|仍有后台任务|运行中的终端/.test(message.text));
	check("the sole conversation of a project closes", !blockD);
	check("an empty fresh chat takes over", client.state.sessionFile !== sessionD && client.state.messages.length === 0);
	check("session D transcript deleted from disk", !existsSync(sessionD));

	// Re-entering the project must still surface that terminal (nothing is left
	// anchored to the deleted conversation).
	client.send({ type: "set_cwd", path: soloDir, source: "ui" });
	await client.waitForState((state) => realpathSync(state.cwd) === realpathSync(soloDir));
	const soloList = await client.waitForType("terminal_list", (message) =>
		message.terminals.some((item) => item.id === terminalD));
	check("its terminal is reachable again on re-entry", soloList.terminals.some((item) => item.id === terminalD && item.running));
	await client.expectAlive(terminalD, "STILL_D");
	check("and it still echoes input after re-entry", true);

	// -- 4. an exited terminal keeps its scrollback ---------------------------
	const terminalExit = "term-exited";
	await client.createTerminal(terminalExit, soloDir);
	client.send({ type: "terminal_input", terminalId: terminalExit, data: "exit\r" });
	await client.waitForType("terminal_exit", (message) => message.terminalId === terminalExit);
	const exitedList = await client.waitForType("terminal_list", (message) =>
		message.terminals.some((item) => item.id === terminalExit && !item.running));
	check("an exited terminal stays in the list with running=false", !exitedList.terminals.find((item) => item.id === terminalExit).running);
	check("its live siblings are untouched", exitedList.terminals.some((item) => item.id === terminalD && item.running));

	console.log(`\n${passed} checks passed`);
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	client?.ws.close();
	server.kill("SIGKILL");
}