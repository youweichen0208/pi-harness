// Exercise the real Electron window, server IPC and SDK with a local model and login site.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
						function: direct ? { name: "embedded_browser", arguments: JSON.stringify(direct === true ? { action: "read" } : direct) } : { name: "codemode", arguments: JSON.stringify({ code: script }) },
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
let slowRequestCount = 0, blockedDestination;
async function waitForSlowRequest(count) {
	for (let i = 0; i < 100 && slowRequestCount < count; i++) await sleep(100);
	assert.ok(slowRequestCount >= count, "guest started the pending navigation");
}
let failNavigation = true;
const site = createServer((req, res) => {
	res.setHeader("content-type", "text/html");
	if (req.url === "/wide") return res.end('<title>Wide</title><main style="width:1100px">Wide layout</main>');
	if (req.url === "/slow") { slowRequestCount++; return; }
	if (req.url === "/retry") {
		if (failNavigation) { res.destroy(); return; }
		return res.end("<title>Recovered</title>");
	}
	if (req.url === "/blocked") { res.writeHead(302, { location: blockedDestination }); res.end(); return; }
	if (req.url === "/redirect") { res.writeHead(302, { location: "/landing" }); res.end(); return; }
	if (req.url === "/visual") return res.end(`<title>Visual</title><style>* {caret-color:transparent}canvas {position:absolute;left:45px;top:40px;width:45px;height:40px;background:green}</style>
		<canvas onclick="document.title='Canvas clicked'"></canvas><form onsubmit="event.preventDefault(); document.title='Sent '+(++window.count)"><input autofocus></form>
		<a href="/icon"><img alt="Account options"></a><a href="/settings?token=private" style="display:block;height:1px"></a><button></button><script>window.count=0</script><details><summary>Details</summary><a href="/page2">Next</a></details>`);
	if (req.url === "/page2") return res.end("<title>Second page</title>Second page result");
	if (req.url === "/login") {
		res.writeHead(303, { location: "/", "set-cookie": "auth=yes; HttpOnly; Max-Age=3600; SameSite=Lax" });
		return res.end();
	}
	res.end(
		req.headers.cookie?.includes("auth=yes")
			? '<title>Account</title><p>Private project 314</p><input aria-label="Name"><button onclick="document.title=document.querySelector(\'input\').value">Save</button><p>' + "long ".repeat(5100) + 'DistantResult</p>'
			: '<title>Login</title><a href="/login">Sign in</a>',
	);
});
async function launch() {
	app = await _electron.launch({
		args: [".", "--force-device-scale-factor=2", "--user-data-dir=" + join(root, "profile")],
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
		assert(await page.getByRole("heading", { name: "pi-harness", exact: true }).getByRole("img", { name: "pi-harness" }).isVisible());
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
					models: [{ id: "fixture", input: ["text", "image"], contextWindow: 64000, maxTokens: 8000 }],
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
	const siteOrigin = "http://127.0.0.1:" + site.address().port;
	const address = page.locator(".embedded-toolbar input");
	async function enterUrl(path) {
		await address.fill(siteOrigin + path);
		await address.press("Enter");
	}
	await enterUrl("/wide");
	await guestTitle("Wide");
	const guestFits = () => app.evaluate(({ webContents }) => webContents.getAllWebContents()
		.find(w => w.getTitle() === "Wide").executeJavaScript("document.documentElement.scrollWidth <= innerWidth + 1"));
	const handle = page.locator(".resize-browser");
	const rect = await handle.boundingBox();
	const panelWidth = () => page.locator(".embedded-browser").evaluate(el => el.clientWidth);
	const before = await panelWidth();
	await page.mouse.move(rect.x + rect.width / 2, rect.y + 12);
	await page.mouse.down();
	await page.mouse.move(rect.x - 65, rect.y + 12, { steps: 5 });
	await page.mouse.up();
	assert(await panelWidth() > before + 50, "drag widens the browser");
	for (let i = 0; i < 50 && !await guestFits(); i++) await sleep(100);
	assert(await guestFits(), "wide page fits after dragging");
	const firstSlow = slowRequestCount + 1;
	await enterUrl("/slow#/login?RelayState=fixture");
	await waitForSlowRequest(firstSlow);
	await enterUrl("/redirect");
	await page.waitForFunction(() => document.querySelector(".embedded-toolbar input").value.endsWith("/landing"));
	assert.equal(await page.locator(".embedded-browser [role=alert]").count(), 0, "replacement navigation must not display an IPC error");
	await enterUrl("/retry#/login?RelayState=fixture");
	const navigationAlert = page.locator(".embedded-browser [role=alert]");
	await navigationAlert.waitFor();
	assert.doesNotMatch(await navigationAlert.innerText(), /IPC|invoking remote method|RelayState/i);
	failNavigation = false;
	await navigationAlert.getByRole("button", { name: /重试|retry/i }).click();
	await guestTitle("Recovered");
	assert.equal(await address.inputValue(), siteOrigin + "/retry#/login?RelayState=fixture");
	blockedDestination = new URL("/blocked-by-policy?RelayState=fixture", page.url()).href;
	await enterUrl("/blocked");
	await navigationAlert.filter({ hasText: "UNSUPPORTED_URL" }).waitFor();
	assert.equal(await navigationAlert.getByRole("button").count(), 0);
	await enterUrl("/");
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
	const clickSave = snapshot => tool("text(await tools.embedded_browser(" + JSON.stringify({ action: "click", snapshot, element: 2 }) + "));");
	const cancelled = clickSave(fresh);
	const confirmation = page.locator(".browser-confirmation");
	await confirmation.getByRole("button").first().click();
	assert.match(await cancelled, /cancelled/);
	await guestTitle("Account");
	const nextToken = (await tool(read)).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)[0];
	const accepted = clickSave(nextToken);
	await confirmation.getByRole("button").last().click();
	assert.match(await accepted, /Done/);
	assert.match(await tool('text(await tools.embedded_browser({action:"find",text:"DistantResult"}))'), /DistantResult/);
	await guestTitle("Saved314");
	async function direct(args) {
		directRead = args;
		return tool();
	}
	assert.match(await direct({action:"find", query:"DistantResult"}), /DistantResult/);
	assert.match(await direct({action:"clickAt", x:10, y:10}), /snapshot: missing|missing snapshot/i);
	assert.match(await direct({action:"find", query:"  "}), /Provide text to find/);
	const getToken = result => result.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)[0];
	const tabs = JSON.parse(JSON.parse(await direct({action:"tabs"})));
	const visualUrl = "http://127.0.0.1:" + site.address().port + "/visual";
	const nextSlow = slowRequestCount + 1;
	const opening = direct({action:"openTab", snapshot:tabs.snapshot, url:siteOrigin + "/slow#/sso?RelayState=fixture"});
	await waitForSlowRequest(nextSlow);
	await enterUrl("/visual");
	assert.match(await opening, /interrupted/);
	await guestTitle("Visual");
	failNavigation = true;
	const failed = await direct({action:"navigate", snapshot:getToken(await direct({action:"read"})), url:siteOrigin + "/retry#/login?RelayState=fixture"});
	assert.match(failed, /ERR_EMPTY_RESPONSE/);
	assert.doesNotMatch(failed, /invoking remote method|RelayState/i);
	failNavigation = false;
	await navigationAlert.getByRole("button").click();
	await guestTitle("Recovered");
	assert.match(await direct({action:"navigate", snapshot:getToken(await direct({action:"read"})), url:visualUrl}), /Navigated/);
	await guestTitle("Visual");
	await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getTitle() === "Visual").setZoomFactor(1.25));
	const view = JSON.parse(JSON.parse(await direct({action:"view"})));
	const pixels = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getTitle() === "Visual").executeJavaScript("({w:innerWidth,h:innerHeight})"));
	const hit = direct({action:"clickAt", snapshot:view.snapshot, x:Math.round(65*view.width/pixels.w), y:Math.round(55*view.height/pixels.h), purpose:"Select the green canvas"});
	await confirmation.getByRole("button").last().click();
	assert.match(await hit, /Done/);
	await guestTitle("Canvas clicked");
	await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getTitle() === "Canvas clicked").executeJavaScript("document.querySelector('input').focus()"));
	const inputSnapshot = getToken(await direct({action:"view"}));
	assert.match(await direct({action:"type", text:"example", snapshot:inputSnapshot}), /Done/);
	assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getTitle() === "Canvas clicked").executeJavaScript("document.querySelector('input').value")), "example");
	assert.match(await direct({action:"type", text:"outdated", snapshot:inputSnapshot}), /Read the active tab again/);
	const press = direct({action:"key", key:"Enter", snapshot:getToken(await direct({action:"view"}))});
	await confirmation.getByRole("button").last().click();
	assert.match(await press, /Done/);
	await guestTitle("Sent 1");
	const overview = JSON.parse(JSON.parse(await direct({action:"read"})));
	assert(overview.elements.some(el => el.label === "Account options"));
	assert(overview.elements.some(el => el.label === new URL("/settings", visualUrl).href));
	assert.match(overview.hint, /view/);
	assert.match(await direct({action:"fill", snapshot:overview.snapshot, element:overview.elements.find(el => el.role === "button").id, text:"test"}), /Unsupported field/);
	const refreshed = JSON.parse(JSON.parse(await direct({action:"read"})));
	const expand = refreshed.elements.find(el => el.label === "Details");
	assert.match(await direct({action:"click", element:expand.id, snapshot:refreshed.snapshot}), /Done/);
	const expanded = JSON.parse(JSON.parse(await direct({action:"read"})));
	assert.match(await direct({action:"click", element:expanded.elements.find(el => el.label === "Next").id, snapshot:expanded.snapshot}), /Done/);
	assert.match(await direct({action:"read"}), /Second page result/);
	await direct({action:"selectTab", tab:tabs.active, snapshot:getToken(await direct({action:"tabs"}))});
	await guestTitle("Saved314");
	const scrollSnapshot = JSON.parse(JSON.parse(await direct({action:"view"})));
	assert.match(await direct({action:"scrollAt", x:40, y:170, direction:"down", snapshot:scrollSnapshot.snapshot}), /Done/);
	assert.ok(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getTitle() === "Saved314").executeJavaScript("scrollY > 0")));
	const beforeResize = getToken(await direct({action:"view"}));
	await page.locator(".embedded-toolbar > button").nth(1).click();
	await page.locator(".embedded-browser.expanded").waitFor();
	await page.locator(".embedded-toolbar > button").nth(1).click();
	assert.match(await direct({action:"clickAt", x:10, y:10, snapshot:beforeResize}), /Read the active tab again/);
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
	const traceDir = join(root, "data", "traces");
	const browserCalls = readdirSync(traceDir).filter(name => name.endsWith(".jsonl")).flatMap(name =>
		readFileSync(join(traceDir, name), "utf8").trim().split("\n").map(line => JSON.parse(line))
			.filter(row => row.type === "tool_end" && row.payload.tool.toolName === "embedded_browser")
			.map(row => row.payload.tool));
	assert(browserCalls.some(call => call.status === "stale_snapshot" && call.isError === false));
	assert(browserCalls.some(call => call.status === "failed" && call.isError === true));
	console.log("PASS embedded browser login, find, tabs, screenshot input, confirmation, stale snapshot, revocation and persistent session");
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
