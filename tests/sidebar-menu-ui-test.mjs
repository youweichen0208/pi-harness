/** Sidebar rows keep time visible, and put destructive actions in one menu. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { testEnv } from "./lib/test-env.mjs";

const port = 8996;
const base = mkdtempSync(join(tmpdir(), "sidebar-menu-"));
const cwd = join(base, "workspace");
mkdirSync(cwd);
const sessionPath = join(base, "greeting.jsonl");
const modified = Date.now();
let server, browser;
const sent = [];
try {
	assert.equal(await portUp(port), false);
	server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...testEnv(), PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(base, "data"), PI_CODING_AGENT_DIR: join(base, "agent") }, stdio: "ignore" });
	for (let i = 0; i < 100 && !await portUp(port); i++) await sleep(100);
	assert(await portUp(port));
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
	await page.routeWebSocket("**/ws", (route) => {
		const upstream = route.connectToServer();
		route.onMessage((wire) => {
			const message = JSON.parse(wire.toString());
			sent.push(message);
			if (!["rename_session", "delete_session", "project_workspace_action"].includes(message.type)) upstream.send(wire);
		});
		upstream.onMessage((wire) => {
			const message = JSON.parse(wire.toString());
			if (message.type === "projects") message.projects = [
				{ path: cwd, lastUsed: modified, lastConversationAt: modified, conversationCount: 2 },
				{ path: "/Users/sidebar-test", lastUsed: modified - 1000, conversationCount: 3 },
				{ path: "/", lastUsed: modified - 2000, conversationCount: 1 },
			];
			if (message.type === "sessions") message.sessions = [
				{ path: sessionPath, firstMessage: "hello", messageCount: 2, modified },
				{ path: join(base, "long.jsonl"), firstMessage: "Go defer 关键字一句话解释", messageCount: 2, modified: modified - 1000 },
			];
			if (message.type === "conversations") message.conversations = [{ id: message.activeId, title: "hello", cwd, messageCount: 2, isStreaming: false, sessionFile: sessionPath, createdAt: modified }];
			// 空目录不再自动发明默认分组：注入一个包含全部项目的分组。
			if (message.type === "project_workspaces") message.catalog = { revision: 1, workspaces: [{ id: "ws-test", name: "测试分组", paths: [cwd, "/Users/sidebar-test", "/"] }] };
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://localhost:${port}`);
	await page.locator(".setup-modal .modal-close").click();
	// 紧凑导航里计数不再可见（display:none），但仍须在 DOM 中携带正确数字。
	await page.locator(".project-item.active .project-count", { hasText: "2" }).waitFor({ state: "attached" });
	assert.equal(await page.locator(".project-path").count(), 0);
	assert.equal(await page.locator(".project-name", { hasText: "根目录" }).count(), 1);
	assert.equal(await page.locator(".project-name", { hasText: "~" }).count(), 1);
	const activeProject = page.locator(".project-item.active");
	assert.equal(await activeProject.locator(".project-chevron").count(), 1);
	const greeting = page.locator(".session-item.active", { hasText: "打招呼" });
	await greeting.waitFor();
	// 顶栏标题已改为固定的会话树入口，不再随会话标题变化。
	assert.equal(await page.locator(".header-location strong").textContent(), "当前会话");
	assert(await greeting.locator(".session-time").isVisible());
	const greetingRow = page.locator(".lp-row", { has: greeting }).last();
	assert.equal(await greetingRow.locator(".lp-menu-trigger").isVisible(), false);
	const rightEdges = await page.evaluate(() => ({ project: document.querySelector(".project-item.active").getBoundingClientRect().right, selected: document.querySelector(".session-item.active").getBoundingClientRect().right }));
	// 紧凑导航里会话行与项目行右缘对齐（左侧缩进表达层级），不再内嵌卡片。
	assert(Math.abs(rightEdges.selected - rightEdges.project) <= 1, JSON.stringify(rightEdges));
	await greeting.hover();
	assert.equal(await greeting.locator(".session-time").isVisible(), false);
	await greetingRow.locator(".lp-menu-trigger").click();
	// 菜单已 portal 到 app 根节点（fixed 定位）：窄侧栏下必须完整落在视口内，
	// 不能被 workspace-directory 的滚动容器裁掉左半边。
	await page.addStyleTag({ content: ".compact-navigation .global-navigation { width: 180px; }" });
	await page.locator(".lp-menu-popover").waitFor();
	const clip = await page.evaluate(() => {
		const menu = document.querySelector(".lp-menu-popover");
		const rect = menu.getBoundingClientRect();
		const hit = document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2);
		return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, vw: innerWidth, vh: innerHeight, hitInside: menu.contains(hit) };
	});
	assert(clip.left >= 0 && clip.right <= clip.vw && clip.top >= 0 && clip.bottom <= clip.vh, JSON.stringify(clip));
	assert(clip.hitInside, JSON.stringify(clip));
	await page.locator(".lp-menu-popover").getByRole("menuitem", { name: "重命名该对话" }).click();
	await page.locator(".lp-inline-input").fill("自定义标题");
	await page.locator(".lp-inline-form").getByRole("button", { name: "确认" }).click();
	assert(sent.some((message) => message.type === "rename_session" && message.name === "自定义标题"));
	await greeting.hover();
	await greetingRow.locator(".lp-menu-trigger").click();
	await page.locator(".lp-menu-popover").getByRole("menuitem", { name: "删除该对话记录（不可恢复）" }).click();
	assert.equal(sent.filter((message) => message.type === "delete_session").length, 0);
	await page.locator(".lp-menu-popover").getByRole("menuitem", { name: "确认删除" }).click();
	assert.equal(sent.filter((message) => message.type === "delete_session").length, 1);
	await activeProject.click();
	assert.equal(await page.locator(".panel-sessions").count(), 0);
	await activeProject.click();
	await greeting.waitFor();
	await activeProject.hover();
	const projectRow = page.locator(".lp-row", { has: activeProject }).first();
	await projectRow.locator(":scope > .lp-menu-zone .lp-menu-trigger").click();
	await page.locator(".lp-menu-popover").getByRole("menuitem", { name: "从分组移除" }).click();
	assert.equal(sent.filter((message) => message.type === "project_workspace_action" && message.action.kind === "remove").length, 0);
	await page.locator(".lp-menu-popover").getByRole("menuitem", { name: "确认移出" }).click();
	assert.equal(sent.filter((message) => message.type === "project_workspace_action" && message.action.kind === "remove").length, 1);
	console.log("PASS sidebar: times, hover menus, two-step delete, counts, paths, title, selected-row spacing, narrow-panel menu clipping");
} finally {
	await browser?.close();
	server?.kill("SIGTERM");
}
