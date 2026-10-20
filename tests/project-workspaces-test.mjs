import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import WebSocket from "ws";

const base = mkdtempSync(join(tmpdir(), "pi-workspace-groups-"));
const projects = ["project-a", "project-b"].map((name) => join(base, name));
for (const path of projects) mkdirSync(path);
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
assert(port >= 8900);
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_CWD: projects[0], PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: join(base, "agent"), PI_WEB_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", (data) => { logs += data; });
server.stderr.on("data", (data) => { logs += data; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sockets = [];
let browser;
async function client(id) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(socket);
	const messages = [];
	socket.on("message", (raw) => messages.push(JSON.parse(raw)));
	await new Promise((r, reject) => { socket.once("open", r); socket.once("error", reject); });
	const send = (message) => socket.send(JSON.stringify(message));
	const wait = async (test) => {
		for (let i = 0; i < 500; i++) { const message = messages.find(test); if (message) return message; await sleep(20); }
		throw new Error(`Message timeout: ${messages.slice(-5).map((m) => m.type)}\n${logs.slice(-2000)}`);
	};
	send({ type: "hello", clientId: id }); await wait((m) => m.type === "snapshot");
	send({ type: "list_project_workspaces" }); await wait((m) => m.type === "project_workspaces");
	return { send, wait, messages };
}
try {
	for (let i = 0; i < 150; i++) {
		try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
		if (i === 149 || server.exitCode !== null) throw new Error(logs);
		await sleep(100);
	}
	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core");
		const { CHROME_PATH } = await import("./lib/chrome.mjs");
		assert(CHROME_PATH, "Chrome unavailable");
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const first = await browser.newPage();
		await first.addInitScript(() => localStorage.setItem("pi-harness:project-workspace", "deleted-workspace"));
		await first.goto(`http://127.0.0.1:${port}`);
		await first.locator(".setup-modal .modal-close").waitFor(); await first.locator(".setup-modal .modal-close").click();
		await first.getByRole("button", { name: "新建 Workspace", exact: true }).first().click();
		await first.getByRole("dialog", { name: "新建 Workspace" }).getByRole("textbox").waitFor();
		await first.getByRole("button", { name: "取消", exact: true }).click();
		assert.equal(await first.locator(".workspace-switcher, .workspace-onboarding").count(), 0);
		assert.equal(await first.locator(".project-item, .session-item").count(), 0);

		await first.screenshot({path: join(tmpdir(), "pi-workspace-first-start.png")});
		await first.close();
	}
	const a = await client("workspace-test-a");
	const b = await client("workspace-test-b");
	a.send({ type: "project_workspace_action", requestId: "create", revision: 0, action: { kind: "create", name: "Work" } });
	const created = await a.wait((m) => m.type === "project_workspace_result" && m.requestId === "create");
	assert.equal(created.ok, true);
	const id = created.workspaceId;
	const synced = await b.wait((m) => m.type === "project_workspaces" && m.catalog.revision === 1);
	assert.equal(synced.catalog.workspaces[0].id, id);
	b.send({ type: "project_workspace_action", requestId: "stale", revision: 0, action: { kind: "delete", id } });
	assert.equal((await b.wait((m) => m.requestId === "stale")).ok, false);
	a.send({ type: "project_workspace_action", requestId: "add", revision: 1, action: { kind: "add", id, path: projects[1] } });
	assert.equal((await a.wait((m) => m.requestId === "add")).ok, true);
	await b.wait((m) => m.type === "project_workspaces" && m.catalog.revision === 2);
	a.send({ type: "get_state" });
	assert(a.messages.filter((m) => m.type === "snapshot").every((m) => m.state.cwd === projects[0]));
	const disk = JSON.parse(readFileSync(join(base, "data", "project-workspaces.json"), "utf8"));
	assert.deepEqual(disk.workspaces[0].paths, [projects[1]]);
	console.log("PASS workspace protocol: shared catalog, conflict recovery, persisted membership, unchanged cwd");
	if (process.argv.includes("--browser")) {
		const page = await browser.newPage();
		const outgoing = [];
		page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => outgoing.push(JSON.parse(String(payload)))));
		await page.goto(`http://127.0.0.1:${port}`);
		await page.locator(".setup-modal .modal-close").waitFor(); await page.locator(".setup-modal .modal-close").click();
		const current = () => page.evaluate(() => document.querySelector(".compact-workspace-trigger > span")?.textContent ?? "");
		const currentIs = (name) => page.waitForFunction((name) => document.querySelector(".compact-workspace-trigger > span")?.textContent === name, name);
		await currentIs("Work");
		const switches = () => outgoing.filter((m) => m.type === "set_cwd").length;
		const before = switches();
		await page.locator(".compact-workspace-trigger").click();
		assert.equal(await page.locator(".workspace-list-row").count(), 1);
		assert.equal(await page.locator(".workspace-list-row > button.active").count(), 1);
		await page.locator(".workspace-picker > input").fill("not-a-workspace");
		assert.equal(await page.locator(".workspace-list-row").count(), 0);
		await page.locator(".workspace-picker > input").fill("work");
		assert.equal(await page.locator(".workspace-list-row").count(), 1);
		await page.keyboard.press("Escape");
		assert.equal(await page.locator(".workspace-picker").count(), 0);
		assert.equal(await page.locator(".drawer-left").evaluate(el => el.getBoundingClientRect().width), 240);
		await page.locator(".directory-toggle").click();
		await page.evaluate(() => document.activeElement?.blur());
		await page.mouse.move(800, 400);
		assert.equal(await page.locator(".drawer-left").evaluate(el => el.getBoundingClientRect().width), 56);
		await page.mouse.move(24, 100);
		assert.equal(await page.locator(".global-navigation").evaluate(el => el.getBoundingClientRect().width), 240);
		assert.equal(await page.locator(".drawer-left").evaluate(el => el.getBoundingClientRect().width), 56);
		await page.locator(".directory-toggle").click();

		await page.locator(`.project-item[title="${projects[1]}"]`).waitFor();
		assert.equal(await page.locator(`.project-item[title="${projects[0]}"]`).count(), 0);
		assert.equal(switches(), before);
		await page.reload();
		await page.locator(".setup-modal .modal-close").waitFor(); await page.locator(".setup-modal .modal-close").click();
		await page.locator(`.project-item[title="${projects[1]}"]`).waitFor();
		assert.equal(await current(), "Work");
		await page.locator(".workspace-project-search").fill("missing");
		assert.equal(await page.locator(".project-item").count(), 0);
		await page.locator(".workspace-project-search").fill("");
		await page.locator(".compact-workspace-trigger").click();
		await page.locator(".workspace-list-row").hover();
		await page.locator(".workspace-list-row .lp-menu-trigger").click();
		await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
		await page.getByRole("dialog").getByRole("textbox").fill("Engineering");
		a.send({ type: "project_workspace_action", requestId: "remote-rename", revision: 2, action: { kind: "rename", id, name: "Remote name" } });
		await currentIs("Remote name");
		assert.equal(await page.getByRole("dialog").getByRole("textbox").inputValue(), "Engineering");
		await page.getByRole("dialog").getByRole("button", { name: "重命名", exact: true }).click();
		await currentIs("Engineering");
		await page.locator(`.project-item[title="${projects[1]}"]`).click();
		await page.locator(`.project-item.active[title="${projects[1]}"]`).waitFor();
		assert.equal(switches(), before + 1);
		await page.locator(`.lp-menu-zone[data-menu-key="proj:${projects[1]}"] .lp-menu-trigger`).click();
		assert.equal(await page.getByRole("menuitem", {name:"新对话", exact:true}).count(), 1);
		await page.keyboard.press("Escape");
		await page.screenshot({ path: join(tmpdir(), "pi-workspace-library.png") });
		await page.locator(".compact-workspace-trigger").click();
		await page.locator(".workspace-list-row").hover();
		await page.locator(".workspace-list-row .lp-menu-trigger").click();
		page.once("dialog", dialog => dialog.accept());
		await page.getByRole("menuitem", { name: "删除分组", exact: true }).click();
		await page.locator(".workspace-list-row").waitFor({ state: "detached" });

		assert(existsSync(projects[1]));
		assert.equal(await page.locator(".project-item, .session-item, .sidebar-new").count(), 0, "deleting the last workspace does not expose recent projects");
		// Manage a group on a narrow viewport without closing the drawer.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.keyboard.press("Escape");
		await page.locator(".project-panel-toggle").click();
		await page.getByRole("button", { name: "新建 Workspace", exact: true }).first().click();
		await page.getByRole("dialog", { name: "新建 Workspace" }).getByRole("textbox").fill("Mobile");
		await page.getByRole("dialog", { name: "新建 Workspace" }).getByRole("button", { name: "创建 Workspace", exact: true }).click();
		await currentIs("Mobile");
		assert.equal(await page.locator(".drawer-left.open").count(), 1);
		assert.equal(await page.locator(".project-item").count(), 0, "new workspaces start empty");
		await page.locator(".lp-add-project").click();
		await page.locator(".fpk-modal-foot input").fill(join(base, "missing"));
		await page.locator(".fpk-open-btn").click();
		await page.locator(".fpk-modal [role=alert]").waitFor();
		await page.locator(".fpk-modal-foot input").fill(projects[0]);
		await page.locator(".fpk-open-btn").click();
		await page.locator(".fpk-modal").waitFor({ state: "detached" });
		assert.equal(await page.locator(".drawer-left.open").count(), 1);
		assert.equal(switches(), before + 1);
		assert.equal(outgoing.filter((m) => m.type === "prompt").length, 0);
		await page.screenshot({ path: join(tmpdir(), "pi-53-workspaces-mobile.png") });
		console.log("PASS workspace browser: filtering, reload preference, search, rename, explicit project switch, non-destructive deletion");
	}
} finally {
	await browser?.close();
	for (const socket of sockets) socket.close();
	server.kill("SIGTERM");
	await Promise.race([new Promise((r) => server.once("exit", r)), sleep(5000)]);
	if (server.exitCode === null) { server.kill("SIGKILL"); await new Promise((r) => server.once("exit", r)); }
	rmSync(base, { recursive: true, force: true });
}
