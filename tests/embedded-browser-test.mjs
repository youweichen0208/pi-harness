// Exercise the real Electron window, server IPC and SDK with a local model and login site.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { _electron } from "playwright-core";
import { listenIsolated } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-embedded-"));
const agent = join(root, "agent");
mkdirSync(agent);
let app, page, code, observed, directRead, directAvailable;
const model = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const request = JSON.parse(body);
	const script = code;
	const direct = directRead;
	directRead = false;
	if (direct) directAvailable = request.tools?.some(tool => tool.function?.name === "embedded_browser");
	code = undefined;
	if (!script && !direct) observed = JSON.parse(body).messages.findLast(m => m.role === "tool");
	const delta = script || direct
		? {
				tool_calls: [
					{
						index: 0,
						id: "call-" + Date.now(),
						type: "function",
						function: direct ? { name: "embedded_browser", arguments: JSON.stringify({ action: "read" }) } : { name: "codemode", arguments: JSON.stringify({ code: script }) },
					},
				],
			}
		: { content: "Completed." };
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const choice of [
		{ index: 0, delta, finish_reason: null },
		{ index: 0, delta: {}, finish_reason: script || direct ? "tool_calls" : "stop" },
	])
		res.write(
			"data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [choice] }) + "\n\n",
		);
	res.end("data: [DONE]\n\n");
});
const site = createServer((req, res) => {
	res.setHeader("content-type", "text/html");
	if (req.url === "/login") {
		res.writeHead(303, { location: "/", "set-cookie": "auth=yes; HttpOnly; Max-Age=3600; SameSite=Lax" });
		return res.end();
	}
	res.end(
		req.headers.cookie?.includes("auth=yes")
			? '<title>Account</title><p>Private project 314</p><input aria-label="Name"><button onclick="document.title=document.querySelector(\'input\').value">Save</button>'
			: '<title>Login</title><a href="/login">Sign in</a>',
	);
});
async function launch() {
	app = await _electron.launch({
		args: [".", "--user-data-dir=" + join(root, "profile")],
		env: { ...process.env, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent, PI_WEB_CWD: root },
	});
	await app.firstWindow();
	for (let i = 0; i < 150; i++) {
		page = app.windows().find(w => w.url().startsWith("http://127.0.0.1:"));
		if (page) break;
		await sleep(100);
	}
	assert.ok(page, "application window");
	page.setDefaultTimeout(10000);
	await page.waitForURL("http://127.0.0.1:*/**");
	await page
		.locator(".topbar-actions")
		.waitFor({ timeout: 15000 })
		.catch(async err => {
			console.error(page.url(), (await page.locator("body").innerText()).slice(-1600));
			throw err;
		});
	if (await page.locator(".setup-modal").count()) await page.locator(".setup-modal .modal-close").click();
	const switcher = page.locator(".view-switch");
	const nodes = switcher.getByRole("tab", { name: /^(节点|Nodes)$/i });
	const browser = switcher.getByRole("button", { name: /^(浏览器|Browser)$/i });
	const files = switcher.locator(".workspace-files-toggle");
	await browser.waitFor();
	assert(await nodes.evaluate(el => el.nextElementSibling?.querySelector("span")?.textContent.match(/^(浏览器|Browser)$/i) && el.nextElementSibling.nextElementSibling?.matches(".workspace-files-toggle")));
	await browser.click();
	await page.locator(".embedded-viewport").waitFor();
	assert.equal(await files.getAttribute("aria-expanded"), "false");
	await files.click();
	assert.equal(await files.getAttribute("aria-expanded"), "true");
	await browser.click();
	assert.equal(await browser.getAttribute("aria-expanded"), "true");
	await page.locator(".embedded-viewport").waitFor();
}
async function go() {
	const home = page.locator(".browser-start-search input");
	const field = await home.isVisible() ? home : page.locator(".embedded-toolbar input");
	if (field === home) {
		await home.focus();
		const ring = el => [getComputedStyle(el).outlineStyle, getComputedStyle(el.parentElement).outlineStyle];
		assert.deepEqual(await home.evaluate(ring), ["none", "solid"]);
		await home.press("Tab");
		const submit = page.locator(".browser-start-search button");
		assert(await submit.evaluate(el => el === document.activeElement));
		assert.deepEqual(await submit.evaluate(ring), ["solid", "none"]);
	}
	await field.fill("http://127.0.0.1:" + site.address().port);
	await field.press("Enter");
}
async function tool(script) {
	code = script;
	observed = undefined;
	const composer = page.locator(".view-pane textarea:visible").first();
	await composer.fill(directRead ? "可以帮我看一下当前网页有哪些内容吗？" : "Use the embedded browser for the requested fixture check.");
	await page.locator(".composer-action.send:visible").click();
	for (let i = 0; i < 300 && !observed; i++) await sleep(100);
	assert.ok(observed, "model received the tool result");
	await sleep(400);
	return JSON.stringify(observed.content);
}
try {
	await listenIsolated(model);
	await listenIsolated(site);
	writeFileSync(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:" + model.address().port,
					apiKey: "fixture",
					models: [{ id: "fixture", input: ["text"], contextWindow: 64000, maxTokens: 8000 }],
				},
			},
		}),
	);
	writeFileSync(
		join(agent, "settings.json"),
		JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultTools: ["+codemode", "+tool_search"] }),
	);
	await launch();
	if (process.env.PI_BROWSER_TEST_SCREENSHOT)
		await page.locator(".embedded-browser").screenshot({ path: process.env.PI_BROWSER_TEST_SCREENSHOT });
	await go();
	const guestTitle = title => page.locator(".embedded-tabs button").filter({ hasText: title }).waitFor();
	await guestTitle("Login");
	await app.evaluate(async ({ webContents }) => {
		const w = webContents.getAllWebContents().find(c => c.getTitle() === "Login");
		await w.executeJavaScript("document.querySelector('a').click()");
	});
	await guestTitle("Account");
	assert.equal(await page.locator(".embedded-browser input[type=checkbox]").count(), 0, "opening the browser authorizes the active conversation");
	directRead = true;
	const read = 'const r=await tools.embedded_browser({action:"read"}); text(r);';
	const result = await tool();
	assert.equal(directAvailable, true, "the first model request must declare the current-page tool");
	assert.match(result, /Private project 314/);
	const snapshotCard = page.locator(".snapshot-card").first();
	await snapshotCard.locator(".snap-title").filter({hasText:"Account"}).waitFor();
	assert.match(await snapshotCard.locator(".snap-url").innerText(), /^http:\/\/127\.0\.0\.1:/);
	assert.equal(await snapshotCard.locator(".snap-json").count(), 0);
	const token = result.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)[0];
	assert.match(
		await tool(
			"text(await tools.embedded_browser(" + JSON.stringify({ action: "fill", snapshot: token, element: 1, text: "Saved314" }) + "));",
		),
		/Done/,
	);
	const fresh = (await tool(read)).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)[0];
	assert.match(
		await tool("text(await tools.embedded_browser(" + JSON.stringify({ action: "click", snapshot: fresh, element: 2 }) + "));"),
		/Done/,
	);
	await guestTitle("Saved314");
	const priorTab = (await tool(read)).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)[0];
	await page.locator(".embedded-toolbar > button").first().click();
	await page.locator(".embedded-viewport section").waitFor();
	await go();
	await guestTitle("Account");
	assert.match(
		await tool("text(await tools.embedded_browser(" + JSON.stringify({ action: "click", snapshot: priorTab, element: 2 }) + "));"),
		/Read the active tab again/,
	);
	await page.locator(".global-new-chat").click();
	await page.locator(".embedded-browser").waitFor({ state: "hidden" });
	assert.match(await tool(read), /inactive/);
	await page.locator(".view-switch").getByRole("button", { name: /^(浏览器|Browser)$/i }).click();
	await guestTitle("Account");
	assert.match(await tool(read), /Private project 314/);
	await page.locator(".embedded-toolbar").first().locator("button").last().click();
	assert.match(await tool(read), /inactive/);
	await app.close();
	app = null;
	await launch();
	await go();
	await guestTitle("Account");
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()
			.find(w => w.webContents.getURL().startsWith("http://127.0.0.1:"))
			.setSize(840, 680),
	);
	const panel = page.locator(".embedded-browser");
	const narrow = await panel.boundingBox();
	assert.ok(narrow.width >= 310 && narrow.x + narrow.width <= 841);
	await panel.locator(".embedded-toolbar > button").nth(1).click();
	await page.waitForFunction(w => document.querySelector(".embedded-browser").clientWidth > w, narrow.width);
	await panel.locator(".embedded-toolbar > button").nth(1).click();
	await app.evaluate(async ({ webContents }) => {
		const guest = webContents.getAllWebContents().find(w => w.getTitle() === "Account");
		await guest.executeJavaScript("window.open('/popup','fixtureLogin'); void 0", true);
	});
	await page.waitForFunction(() => document.querySelectorAll(".embedded-tabs > div").length === 2);
	await app.evaluate(async ({ webContents }) => {
		const popup = webContents.getAllWebContents().find(w => w.getURL().endsWith("/popup"));
		if (!popup || !(await popup.executeJavaScript("!!window.opener && !window.electronAPI && !window.require")))
			throw Error("Popup opener or isolation lost");
	});
	console.log("PASS embedded browser login, SDK read/fill/click, stale tab, revocation and persistent session");
} catch (err) {
	console.error(
		page?.url(),
		(
			await page
				?.locator("body")
				.innerText()
				.catch(() => "")
		)?.slice(0, 2400),
	);
	throw err;
} finally {
	await app?.close();
	model.close();
	site.close();
	rmSync(root, { recursive: true, force: true });
}
