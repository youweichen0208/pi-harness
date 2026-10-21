import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { testEnv } from "./lib/test-env.mjs";
const root = mkdtempSync(join(tmpdir(), "pi-notes-api-"));
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
assert(port >= 8900);
const base = `http://127.0.0.1:${port}`;
const token = "notes-test-only";
let server, browser, logs = "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
	server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...testEnv(), PORT: String(port), PI_WEB_TOKEN: token, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_CWD: root }, stdio: ["ignore", "pipe", "pipe"] });
	server.stdout.on("data", data => { logs += data; }); server.stderr.on("data", data => { logs += data; });
	for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {} if (server.exitCode !== null) break; await sleep(100); }
	throw new Error(logs);
}
async function stop() { if (server?.exitCode === null) { server.kill("SIGTERM"); await Promise.race([new Promise(resolve => server.once("exit", resolve)), sleep(5000)]); if (server.exitCode === null) { server.kill("SIGKILL"); await new Promise(resolve => server.once("exit", resolve)); } } }
async function api(path = "", method = "GET", body, headers = {}) { return fetch(`${base}/api/notes${path}${path.includes("?") ? "&" : "?"}token=${token}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }); }
async function until(test) { for (let i = 0; i < 100; i++) { if (await test()) return; await sleep(100); } throw new Error("Condition timeout"); }
async function sourceEditor(page) {
	const source = page.getByRole("button", { name: "Markdown 源码", exact: true });
	if (await source.count()) await source.click();
	return page.getByLabel("小记正文", { exact: true });
}
try {
	await start();
	assert.equal((await fetch(`${base}/api/notes`)).status, 401);
	assert.equal((await api("", "GET", undefined, { Origin: "https://evil.example" })).status, 403);
	assert.equal((await api("", "POST", { title: 3 })).status, 400);
	const note = (await (await api("", "POST", { title: "API", body: "searchable body", pinned: false })).json()).note;
	assert.equal((await (await api("?q=SEARCHABLE")).json()).notes.length, 1);
	const update = { ...note, body: "retained" };
	const responses = await Promise.all([api(`/${note.id}`, "PUT", update), api(`/${note.id}`, "PUT", update)]);
	assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
	assert.equal((await api(`/${note.id}`, "DELETE", { version: 1 })).status, 409);
	await stop(); await start();
	assert.equal((await (await api(`/${note.id}`)).json()).note.body, "retained");
	assert.equal((await api(`/${note.id}`, "DELETE", { version: 2 })).status, 200);
	console.log("PASS notes API: auth, origin, validation, search, concurrent conflict, restart and deletion");
	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core");
		const { CHROME_PATH } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		const page = await context.newPage();
		const outgoing = [];
		page.on("websocket", socket => socket.on("framesent", ({ payload }) => outgoing.push(JSON.parse(String(payload)))));
		await page.goto(`${base}/?token=${token}`);
		await page.locator(".setup-modal .modal-close").click();
		const chatInput = page.locator(".inputbox textarea");
		await chatInput.fill("chat draft survives notes");
		await page.getByRole("button", { name: "小记", exact: true }).click();
		await page.getByRole("button", { name: "新建小记", exact: true }).first().click();
		await page.getByLabel("小记标题", { exact: true }).fill("Personal");
		await page.getByRole("button", { name: "Markdown 源码", exact: true }).click();
		await (await sourceEditor(page)).fill("- [ ] test task\nprivate note body");
		await until(async () => (await (await api()).json()).notes[0]?.body.includes("private note body"));
		await page.getByRole("button", { name: "预览", exact: true }).click();
		await page.locator(".notes-preview input[type=checkbox]").check();
		await until(async () => (await (await api()).json()).notes[0]?.body.match(/^-\s+\[x\]/));
		await page.getByRole("button", { name: "置顶", exact: true }).click();
		await until(async () => (await (await api()).json()).notes[0]?.pinned);
		await page.getByRole("button", { name: "对话", exact: true }).click();
		assert.equal(await chatInput.inputValue(), "chat draft survives notes");
		await page.getByRole("button", { name: "小记", exact: true }).click();
		if (await page.getByRole("button", { name: "编辑", exact: true }).count()) await page.getByRole("button", { name: "编辑", exact: true }).click();
		const saved = (await (await api()).json()).notes[0];
		const second = await context.newPage();
		await second.goto(`${base}/?token=${token}`);
		await second.locator(".setup-modal .modal-close").click();
		await second.getByRole("button", { name: "小记", exact: true }).click();
		await second.locator(".note-list-item").first().click();
		await second.getByLabel("小记标题", { exact: true }).fill("Remote winner");
		await until(async () => (await (await api(`/${saved.id}`)).json()).note.title === "Remote winner");
		await (await sourceEditor(page)).fill("local conflict draft");
		await page.getByText("小记已在其他窗口修改或删除。", { exact: false }).waitFor();
		assert.equal(await (await sourceEditor(page)).inputValue(), "local conflict draft");
		await page.getByRole("button", { name: "另存为新小记", exact: true }).click();
		await until(async () => (await (await api()).json()).notes.length === 2);
		await page.locator(".notes-error").waitFor({ state: "detached" });
		await page.route("**/api/notes/*", route => route.request().method() === "PUT" ? route.abort() : route.continue());
		await (await sourceEditor(page)).fill("offline preserved draft");
		await page.locator(".notes-error").waitFor();
		await page.getByRole("button", { name: "对话", exact: true }).click();
		await page.getByRole("button", { name: "小记", exact: true }).click();
		assert.equal(await (await sourceEditor(page)).inputValue(), "offline preserved draft");
		assert.equal(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
		await page.unroute("**/api/notes/*");
		await page.locator(".notes-error").getByRole("button", { name: "重试", exact: true }).click();
		await until(async () => (await (await api()).json()).notes.some(note => note.body === "offline preserved draft"));
		// Keep typing after the server commits but before the response reaches the editor.
		await page.route("**/api/notes/*", async route => {
			if (route.request().method() !== "PUT") { await route.continue(); return; }
			const response = await route.fetch(); await sleep(700); await route.fulfill({ response });
		});
		await (await sourceEditor(page)).fill("first in flight");
		await until(async () => (await (await api()).json()).notes.some(note => note.body === "first in flight"));
		await (await sourceEditor(page)).fill("newer edit survives response");
		await until(async () => (await (await api()).json()).notes.some(note => note.body === "newer edit survives response"));
		await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
		await page.unroute("**/api/notes/*");
		await page.getByLabel("搜索标题与正文", { exact: true }).fill("not present");
		await page.getByText("没有找到匹配的小记", { exact: true }).waitFor();
		await page.getByLabel("搜索标题与正文", { exact: true }).fill("");
		assert.equal(await page.locator(".global-navigation").evaluate(el => Math.round(el.getBoundingClientRect().width)), 240);
		assert.equal(await page.locator(".global-navigation .workspace-directory").count(), 1);
		await page.getByRole("button", { name: "展开或收起目录" }).click();
		await page.evaluate(() => document.activeElement?.blur());
		await page.mouse.move(800, 400);
		assert.equal(await page.locator(".workspace-directory").isVisible(), false);
		await page.getByRole("button", { name: "展开或收起目录" }).click();
		assert.equal(await page.locator(".workspace-directory").isVisible(), true);
		await page.screenshot({ path: join(tmpdir(), "pi-notes-desktop.png") });
		await page.evaluate(() => { localStorage.setItem("pi-harness:theme", "graphite"); window.dispatchEvent(new StorageEvent("storage", { key: "pi-harness:theme" })); });
		assert.equal(await page.locator("html").getAttribute("data-appearance"), "dark");
		await page.screenshot({ path: join(tmpdir(), "pi-notes-dark.png") });
		page.once("dialog", dialog => dialog.accept());
		await page.getByRole("button", { name: "删除小记", exact: true }).click();
		await until(async () => (await (await api()).json()).notes.length === 1);
		await second.close();
		await page.setViewportSize({ width: 390, height: 844 });
		await page.locator(".project-panel-toggle").click();
		await page.waitForFunction(() => Math.abs(document.querySelector(".drawer-left.open")?.getBoundingClientRect().x ?? -1000) < 1);
		await page.screenshot({ path: join(tmpdir(), "pi-notes-mobile.png") });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		assert.equal(outgoing.filter(message => ["prompt", "new_chat", "set_cwd"].includes(message.type)).length, 0, "notes never create agent work or change cwd");
		console.log("PASS notes browser: autosave, task checkbox, pins, chat draft, conflict copy, offline retry, leave protection, search and responsive layout");
	}
} finally { await browser?.close(); await stop(); rmSync(root, { recursive: true, force: true }); }
