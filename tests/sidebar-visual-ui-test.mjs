import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-sidebar-visual-"));
const cwd = join(root, "pi-harness");
const other = join(root, "design-system");
const data = join(root, "data");
const agent = join(root, "agent");
mkdirSync(cwd, { recursive: true });
mkdirSync(other, { recursive: true });
mkdirSync(data, { recursive: true });
mkdirSync(agent, { recursive: true });
mkdirSync("tests/scratch", { recursive: true });
writeFileSync(join(data, "project-workspaces.json"), JSON.stringify({ revision: 1, workspaces: [{ id: "workspace", name: "pi-harness", paths: [cwd, other] }] }));
const now = Date.now();
const activePath = join(root, "active.jsonl");
const harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent } });
let browser;
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.routeWebSocket("**/ws", route => {
		const upstream = route.connectToServer();
		route.onMessage(wire => upstream.send(wire));
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === "projects") message.projects = [
				{ path: cwd, lastUsed: now, lastConversationAt: now, conversationCount: 2 },
				{ path: other, lastUsed: now - 3600000, conversationCount: 4 },
			];
			if (message.type === "sessions") message.sessions = [
				{ path: activePath, firstMessage: "可以帮我读一下浏览器里的内容", messageCount: 6, modified: now },
				{ path: join(root, "hello.jsonl"), firstMessage: "打招呼", messageCount: 2, modified: now - 3600000 },
			];
			if (message.type === "conversations") message.conversations = [{ id: message.activeId, title: "可以帮我读一下浏览器里的内容", cwd, messageCount: 6, isStreaming: false, sessionFile: activePath, createdAt: now }];
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${harness.port}`);
	const active = page.locator(".session-item.active", { hasText: "可以帮我读一下浏览器里的内容" });
	await active.waitFor();
	const setup = page.locator(".setup-modal .modal-close");
	if (await setup.count()) {
		await setup.click();
		await page.locator(".setup-modal").waitFor({ state: "detached" });
	}
	await page.evaluate(() => document.documentElement.classList.add("pi-desktop", "pi-desktop-darwin"));
	await page.evaluate(() => document.fonts.ready);
	const geometry = await page.evaluate(() => ({
		brandHeight: document.querySelector(".compact-brand .brand-wordmark").getBoundingClientRect().height,
		brandViewBox: document.querySelector(".compact-brand .brand-wordmark").getAttribute("viewBox"),
		projectName: document.querySelector(".project-item.active .project-name").getBoundingClientRect().left,
		sessionTitle: document.querySelector(".session-item.active .session-title").getBoundingClientRect().left,
		directoryBorder: getComputedStyle(document.querySelector(".compact-navigation .workspace-directory")).borderTopWidth,
		selectedShadow: getComputedStyle(document.querySelector(".session-item.active")).boxShadow,
		footerBorder: getComputedStyle(document.querySelector(".compact-navigation .sidebar-footer")).borderTopWidth,
	}));
	assert.equal(geometry.brandHeight, 19, "the existing Logo size stays unchanged");
	assert.equal(geometry.brandViewBox, "421 249 1384 205", "the existing Logo artwork stays unchanged");
	assert(geometry.sessionTitle >= geometry.projectName + 4, JSON.stringify(geometry));
	assert.equal(geometry.directoryBorder, "0px");
	assert.equal(geometry.selectedShadow, "none");
	assert.equal(geometry.footerBorder, "0px");
	await active.hover();
	const row = page.locator(".lp-row", { has: active }).last();
	await row.locator(".lp-menu-trigger").click();
	await row.getByRole("menu").waitFor();
	await page.keyboard.press("Escape");
	await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
	await page.mouse.move(0, 0);
	await page.locator(".compact-navigation .global-navigation").screenshot({ path: "tests/scratch/sidebar-visual-light.png" });
	await page.evaluate(() => document.documentElement.dataset.appearance = "dark");
	await page.locator(".compact-navigation .global-navigation").screenshot({ path: "tests/scratch/sidebar-visual-dark.png" });
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await page.emulateMedia({ reducedMotion: "reduce" });
	assert.equal(await page.locator(".compact-workspace-trigger").evaluate(element => getComputedStyle(element).transitionDuration), "0s");
	await page.evaluate(() => {
		document.documentElement.classList.remove("pi-desktop", "pi-desktop-darwin");
		document.documentElement.dataset.appearance = "light";
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator(".topbar .brand .panel-toggle").click();
	await page.waitForFunction(() => !document.querySelector(".drawer-left").inert);
	await active.waitFor({ state: "visible" });
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await page.locator(".drawer-left .compact-navigation .global-navigation").screenshot({ path: "tests/scratch/sidebar-visual-mobile.png" });
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => document.querySelector(".drawer-left").inert);
	assert.deepEqual(errors, []);
	console.log("PASS sidebar visual hierarchy, unchanged Logo, hover menu, dark theme, reduced motion and mobile drawer");
} finally {
	await browser?.close();
	await harness.stop();
	rmSync(root, { recursive: true, force: true });
}
