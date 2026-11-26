/**
 * Terminal workspace scoping.
 *
 * Terminals are project-workspace resources (see server/terminal-registry.ts),
 * so routing is by `workspaceId` — never by conversation. This test pins the
 * client-visible consequences:
 *
 *   1. the snapshot carries a canonical `workspaceId` and terminal_list echoes
 *      exactly that value (the client must not derive it from cwd itself);
 *   2. switching conversations INSIDE one project keeps the same list (no
 *      recreate, still the same PTY id) — terminal tabs must not flicker;
 *   3. switching PROJECT swaps the list and no output from the other project
 *      leaks into the active view;
 *   4. a background project's terminal keeps running and replays its output
 *      when the project is reopened;
 *   5. a second browser tab (same clientId) sees the same shared list;
 *   6. killing a terminal in a background project does not disturb the active
 *      project's tabs.
 *
 * Usage: npm run build && node tests/terminal-workspace-scope-test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { testEnv } from "./lib/test-env.mjs";

const PORT = 8969;
const base = mkdtempSync(join(tmpdir(), "pi-web-terminal-scope-"));
const projectA = join(base, "alpha");
const projectB = join(base, "beta");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const dir of [projectA, projectB, dataDir]) mkdirSync(dir, { recursive: true });
// Windows may give us an 8.3 alias in tmpdir(). Keep sending the original cwd,
// but compare workspace identities using the on-disk spelling from the OS.
const canonicalA = realpathSync.native(projectA);
const canonicalB = realpathSync.native(projectB);

const seed = (cwd, id, text) => {
	const dir = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-10-19T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, [
		{ type: "session", version: 3, id, timestamp: "2026-10-19T00:00:00.000Z", cwd },
		{ type: "message", id: `user-${id}`, parentId: null, timestamp: "2026-10-19T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } },
	].map((row) => JSON.stringify(row)).join("\n") + "\n");
	return file;
};
const sessionA1 = seed(projectA, "A1", "ALPHA_ONE");
const sessionA2 = seed(projectA, "A2", "ALPHA_TWO");
const sessionB = seed(projectB, "B1", "BETA_ONE");

const repoRoot = realpathSync(new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...testEnv(),
		PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: projectA,
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
		} catch { /* starting */ }
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
			else if (message.type === "snapshot_delta" && this.state &&
				this.state.rev === message.baseRev && message.conversationId === this.state.conversationId) {
				this.state = { ...this.state, ...message.state };
			}
		});
	}
	send(message) { this.ws.send(JSON.stringify(message)); }
	async waitForType(type, predicate = () => true, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const index = this.received.findIndex((m) => m.type === type && predicate(m));
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
	/** Everything still queued in the inbox (drains nothing). */
	peek() { return [...this.received]; }
	/** Await output on a terminal and return the accumulated text. */
	async expectOutput(terminalId, marker, timeout = 15000) {
		const started = Date.now();
		let text = "";
		while (Date.now() - started < timeout) {
			const index = this.received.findIndex((m) => m.type === "terminal_output" && m.terminalId === terminalId);
			if (index >= 0) {
				const message = this.received.splice(index, 1)[0];
				text += message.data;
				if (text.includes(marker)) return text;
			} else await sleep(50);
		}
		throw new Error(`timeout waiting for ${marker} on ${terminalId} (saw: ${JSON.stringify(text.slice(-200))})`);
	}
}

const connect = async (clientId) => {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const client = new Client(ws);
	client.send({ type: "hello", clientId });
	await client.waitForType("ready");
	// The browser requests a FULL snapshot after ready (a same-client-id socket
	// would otherwise only receive snapshot_delta frames).
	client.send({ type: "get_state" });
	await client.waitForState((state) => Boolean(state.conversationId));
	return client;
};

const clients = [];
let passed = 0;
const check = (name, condition) => {
	assert.ok(condition, name);
	passed++;
	console.log(`  ✓ ${name}`);
};

try {
	await waitForPort(PORT);
	const primary = await connect("terminal-scope-test");
	clients.push(primary);

	// -- 1. the snapshot owns the canonical workspace key ----------------------
	primary.send({ type: "switch_session", path: sessionA1 });
	await primary.waitForState((state) => state.sessionFile === sessionA1);
	const workspaceA = primary.state.workspaceId;
	check("snapshot carries a workspaceId", typeof workspaceA === "string" && workspaceA.length > 0);
	check("workspaceId is the canonical project root", workspaceA === canonicalA);

	const terminalA = "term-alpha";
	primary.send({ type: "terminal_create", terminalId: terminalA, cwd: projectA, cols: 60, rows: 16, workspaceId: workspaceA });
	const created = await primary.waitForType("terminal_list", (m) => m.terminals.some((t) => t.id === terminalA));
	check("terminal_list echoes the snapshot workspaceId", created.workspaceId === workspaceA);
	primary.send({ type: "terminal_input", terminalId: terminalA, data: "echo ALPHA_READY\r", workspaceId: workspaceA });
	await primary.expectOutput(terminalA, "ALPHA_READY");

	// -- 2. same project, different conversation: identical list --------------
	primary.send({ type: "switch_session", path: sessionA2 });
	await primary.waitForState((state) => state.sessionFile === sessionA2);
	check("same-project conversation switch keeps the workspace", primary.state.workspaceId === workspaceA);
	const listAfterSwitch = await primary.waitForType("terminal_list", (m) => m.terminals.length > 0);
	check("the tab is the SAME PTY id (no recreate)", listAfterSwitch.terminals.some((t) => t.id === terminalA && t.running));
	check("and the list is still keyed by the same workspace", listAfterSwitch.workspaceId === workspaceA);

	// -- 3. project switch swaps the list, no cross-project output ------------
	primary.send({ type: "set_cwd", path: projectB, source: "ui" });
	await primary.waitForState((state) => realpathSync.native(state.cwd) === canonicalB);
	const workspaceB = primary.state.workspaceId;
	check("switching project changes the workspace key", workspaceB === canonicalB && workspaceB !== workspaceA);
	const emptyList = await primary.waitForType("terminal_list", (m) => m.workspaceId === workspaceB);
	check("the new project starts with an empty list", emptyList.terminals.length === 0);

	// Drain everything queued before the switch: from here on, ANY message from
	// project A means terminal routing leaked across projects.
	primary.received.length = 0;

	// Drive the BACKGROUND project's terminal and prove nothing leaks into the
	// active view. The server buffers it for replay instead of streaming it.
	primary.send({ type: "terminal_input", terminalId: terminalA, data: "echo BACKGROUND_NOISE\r", workspaceId: workspaceA });
	await sleep(1200);
	const leaked = primary.peek().filter((m) =>
		(m.type === "terminal_output" || m.type === "terminal_list" || m.type === "terminal_exit") && m.workspaceId === workspaceA);
	check("no output/list from the background project reaches the view", leaked.length === 0);

	// -- 4. the background terminal kept running and replays on return -------
	primary.send({ type: "terminal_kill", terminalId: "does-not-exist", workspaceId: workspaceA });
	primary.send({ type: "set_cwd", path: projectA, source: "ui" });
	await primary.waitForState((state) => realpathSync.native(state.cwd) === canonicalA);
	const backList = await primary.waitForType("terminal_list", (m) => m.workspaceId === workspaceA);
	check("returning to the project restores its tab", backList.terminals.some((t) => t.id === terminalA && t.running));
	const replay = await primary.expectOutput(terminalA, "BACKGROUND_NOISE");
	check("the background output was buffered and replayed", replay.includes("BACKGROUND_NOISE"));

	// -- 5. a second tab shares the same workspace terminals ------------------
	const second = await connect("terminal-scope-test");
	clients.push(second);
	const sharedList = await second.waitForType("terminal_list", (m) => m.terminals.some((t) => t.id === terminalA));
	check("a second tab sees the same shared terminal", sharedList.workspaceId === workspaceA);
	second.send({ type: "terminal_input", terminalId: terminalA, data: "echo SHARED_TAB\r", workspaceId: workspaceA });
	await second.expectOutput(terminalA, "SHARED_TAB");
	await primary.expectOutput(terminalA, "SHARED_TAB");
	check("input from one tab reaches the PTY and both see the output", true);

	// -- 6. background kill does not disturb the active project --------------
	second.send({ type: "set_cwd", path: projectB, source: "ui" });
	await second.waitForState((state) => realpathSync.native(state.cwd) === canonicalB);
	// Both sockets share a client. The snapshot from the second socket's switch
	// already shows beta, so it cannot confirm the primary socket's request.
	primary.send({ type: "set_cwd", path: projectB, source: "ui", requestId: "primary-switch-to-beta" });
	const switched = await primary.waitForType("cwd_result", (m) => m.requestId === "primary-switch-to-beta");
	assert.equal(switched.ok, true, switched.error);
	await primary.waitForState((state) => realpathSync.native(state.cwd) === canonicalB);
	const terminalB = "term-beta";
	primary.send({ type: "terminal_create", terminalId: terminalB, cwd: projectB, cols: 60, rows: 16 });
	await primary.waitForType("terminal_list", (m) => m.terminals.some((t) => t.id === terminalB));
	primary.send({ type: "terminal_input", terminalId: terminalB, data: "echo BETA_READY\r" });
	await primary.expectOutput(terminalB, "BETA_READY");
	primary.received.length = 0;

	primary.send({ type: "terminal_kill", terminalId: terminalA, workspaceId: workspaceA });
	await sleep(600);
	const afterKill = primary.peek().filter((m) => m.type === "terminal_list");
	check("killing a background tab pushes no list into the active project", afterKill.length === 0);
	primary.send({ type: "terminal_input", terminalId: terminalB, data: "echo BETA_STILL_HERE\r" });
	await primary.expectOutput(terminalB, "BETA_STILL_HERE");
	check("the active project's terminal is unaffected", true);

	console.log(`\n${passed} checks passed`);
} catch (error) {
	console.error(`✗ ${error.message}`);
	for (const [i, c] of clients.entries()) console.error(`client[${i}] types:`, JSON.stringify(c.received.map((m) => `${m.type}${m.workspaceId ? ":" + m.workspaceId.split("/").pop() : ""}`).slice(-25)));
	for (const [i, c] of clients.entries()) console.error(`client[${i}] cwd:`, c.state?.cwd, "ws:", c.state?.workspaceId);
	process.exitCode = 1;
} finally {
	for (const client of clients) client.ws.close();
	server.kill("SIGKILL");
}
