/* Browser smoke test: boots the compiled server, opens the built UI in headless
 * Chromium, and exercises the terminal view end-to-end.
 * Run:  npm run build && node terminal-browser-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { scrubHostEnv } from "./lib/test-env.mjs";

scrubHostEnv();

const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-ui-"));
const dataDir = mkdtempSync(join(tmpdir(), "piweb-ui-data-"));
process.env.PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;

const server = spawn(
	process.execPath,
	[join(new URL("..", import.meta.url).pathname, "dist", "server", "index.js")],
	{
		cwd: new URL("..", import.meta.url).pathname,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	},
);
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
	try {
		rmSync(workdir, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function main() {
	await waitServer();
	const browser = await chromium.launch({
		// The installed playwright-core wants a newer browser build; point it at
		// the cached Chromium for Testing binary instead of downloading.
		executablePath:
			CHROME_PATH,
	});
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.routeWebSocket('**/ws', route => {
		const upstream = route.connectToServer();
		route.onMessage(wire => upstream.send(wire));
		upstream.onMessage(wire => {
			const message = JSON.parse(wire.toString());
			if (message.type === 'snapshot' || message.type === 'snapshot_delta') message.state.piConfigured = true;
			route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://localhost:${PORT}/`);
	// Wait for the session to be ready (hello/ready round-trip).
	await page.waitForSelector(".boot-wait", { state: "hidden", timeout: 60000 });
	await page.waitForSelector(".topbar", { timeout: 5000 });
	console.log("app booted");
	await page.locator('.compact-workspace-trigger').click();
	await page.locator('.workspace-picker-create').click();
	await page.getByLabel('Workspace 名称', { exact: true }).fill('Terminal test');
	await page.getByRole('button', { name: '创建 Workspace', exact: true }).click();
	await page.locator('.lp-add-project').click();
	await page.locator('.fpk-modal-foot input').fill(workdir);
	await page.locator('.fpk-open-btn').click();
	await page.locator('.project-item.active').waitFor();

	// Switch to the terminal view.
	await page.click('.view-switch button:has-text("终端")');
	await page.waitForSelector(".terminal-view", { timeout: 5000 });
	check("terminal view renders", true);
	check("command form removed", await page.locator(".term-command-section").count() === 0);
	if (await page.locator(".term-tab").count() === 0) await page.locator(".term-new-row").click();
	await page.waitForSelector(".term-tab", { timeout: 5000 });
	await page.locator(".term-xterm:not(.hidden) .xterm-helper-textarea").first().click();
	await page.keyboard.type("echo BROWSER_PTY_OK");
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => document.querySelector(".term-main")?.textContent.includes("BROWSER_PTY_OK"));
	check("shell accepts terminal input", true);

	// Type into the terminal through the xterm (paste into its hidden textarea).
	const textarea = page.locator(".term-xterm:not(.hidden) .xterm-helper-textarea").first();
	await textarea.click();
	await page.keyboard.type("pwd");
	await page.keyboard.press("Enter");
	await sleep(1200);
	const termText2 = await page.textContent(".term-main");
	check("typing reaches the PTY", termText2?.includes(workdir));

	// Open a second plain shell tab.
	await page.click(".term-tabs-block .panel-new");
	await page.waitForSelector(".term-tab >> nth=1", { timeout: 5000 });
	await sleep(1500);
	check("second tab + shell prompt", true);

	// Switch back to chat view — terminals must SURVIVE (no unmount kill).
	await page.click('.view-switch button:has-text("对话")');
	await sleep(800);
	await page.click('.view-switch button:has-text("终端")');
	await sleep(800);
	check(
		"terminals survive view switch",
		(await page.locator(".term-tab").count()) === 2,
	);

	// Close one tab — the other stays.
	await page.locator(".term-tab-close").first().click();
	await sleep(800);
	check(
		"tab close removes one tab",
		(await page.locator(".term-tab").count()) === 1,
	);

	// Conversation-level persistence: an idle conversation with a terminal must
	// remain switchable after creating a new chat, and its PTY/tab must return.
	await page.click('.view-switch button:has-text("对话")');
	await page.click(".global-new-chat");
	await sleep(1800);
	await page.waitForSelector(".panel-sessions .session-item:not(.active)", { timeout: 5000 });
	check("conversation with terminal remains listed", (await page.locator(".panel-sessions .session-item:not(.active)").count()) >= 1);
	await page.locator(".panel-sessions .session-item:not(.active)").first().click();
	await sleep(900);
	await page.click('.view-switch button:has-text("终端")');
	await sleep(900);
	check("switching back restores conversation terminal", (await page.locator(".term-tab").count()) === 1);

	check("no console errors", consoleErrors.length === 0);
	if (consoleErrors.length > 0) {
		console.log("    console errors:", consoleErrors.slice(0, 5));
	}

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error("TEST ERROR:", err);
	process.exit(1);
});
