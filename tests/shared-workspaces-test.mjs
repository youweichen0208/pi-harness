// Two servers with separate data dirs share one workspace file (desktop + CLI):
// an older per-app catalog is merged once, and a change in one shows up in the other.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
import WebSocket from "ws";

const base = mkdtempSync(join(tmpdir(), "pi-shared-workspaces-"));
const project = join(base, "project");
mkdirSync(project);
const sharedFile = join(base, "cli-data", "project-workspaces.json");
const legacyFile = join(base, "desktop-data", "project-workspaces.json");
mkdirSync(join(base, "desktop-data"));
writeFileSync(legacyFile, JSON.stringify({ revision: 2, workspaces: [{ id: "old-desktop", name: "Desktop", paths: [project] }] }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
async function start(dataDir, workspacesFile) {
	const nativeAgent = join(base, dataDir, "omp", "agent");
	mkdirSync(nativeAgent, { recursive: true });
	writeFileSync(join(nativeAgent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
	const env = { PI_WEB_CWD: project, PI_WEB_DATA_DIR: join(base, dataDir), PI_WEB_TOKEN: "" };
	if (workspacesFile) env.PI_WEB_WORKSPACES_FILE = workspacesFile;
	const harness = await startIsolatedHarness({ env });
	servers.push(harness);
	return harness;
}
const sockets = [];
async function client({ port, logs }, id) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(socket);
	const messages = [];
	socket.on("message", (raw) => messages.push(JSON.parse(raw)));
	await new Promise((r, reject) => { socket.once("open", r); socket.once("error", reject); });
	const send = (message) => socket.send(JSON.stringify(message));
	const wait = async (test) => {
		for (let i = 0; i < 1500; i++) { const message = messages.findLast(test); if (message) return message; await sleep(20); }
		throw new Error(`Message timeout: ${messages.slice(-5).map((m) => m.type)}\n${logs.slice(-2000)}`);
	};
	send({ type: "hello", clientId: id }); await wait((m) => m.type === "ready");
	send({ type: "list_project_workspaces" });
	return { send, wait };
}
try {
	const cli = await start("cli-data");
	const desktop = await start("desktop-data", sharedFile);
	assert.equal(existsSync(legacyFile), false, "the desktop's own catalog is merged once");
	assert.equal(existsSync(`${legacyFile}.merged`), true);
	assert.deepEqual(JSON.parse(readFileSync(sharedFile, "utf8")).workspaces, [{ id: "old-desktop", name: "Desktop", paths: [project] }]);

	const a = await client(cli, "shared-cli");
	const b = await client(desktop, "shared-desktop");
	const listed = await a.wait((m) => m.type === "project_workspaces");
	assert.deepEqual(listed.catalog.workspaces.map((group) => group.name), ["Desktop"]);
	await b.wait((m) => m.type === "project_workspaces");

	a.send({ type: "project_workspace_action", requestId: "create", revision: listed.catalog.revision, action: { kind: "create", name: "From CLI" } });
	assert.equal((await a.wait((m) => m.type === "project_workspace_result")).ok, true);
	const pushed = await b.wait((m) => m.type === "project_workspaces" && m.catalog.workspaces.length === 2);
	assert.deepEqual(pushed.catalog.workspaces.map((group) => group.name), ["Desktop", "From CLI"]);

	b.send({ type: "project_workspace_action", requestId: "rename", revision: pushed.catalog.revision, action: { kind: "rename", id: "old-desktop", name: "Renamed" } });
	assert.equal((await b.wait((m) => m.type === "project_workspace_result")).ok, true);
	await a.wait((m) => m.type === "project_workspaces" && m.catalog.workspaces[0]?.name === "Renamed");
	console.log("shared-workspaces-test: ok");
} finally {
	for (const socket of sockets) socket.close();
	await Promise.all(servers.map(server => server.stop()));
	rmSync(base, { recursive: true, force: true });
}
