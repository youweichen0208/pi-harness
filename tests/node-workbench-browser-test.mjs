import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startMockSsh } from "./lib/mock-ssh.mjs";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testEnv } from "./lib/test-env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(join(root, "tests/scratch"), { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "pi-node-browser-"));
const port = 8946, sshPort = 22946;
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const mock = await startMockSsh(root, sshPort, [ssh2.utils.parseKey(privateKey)]);
const server = spawn(process.execPath, [join(root, "dist/server/index.js")], { cwd: root, env: { ...testEnv(), PORT: String(port), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: root, PI_CODING_AGENT_DIR: join(dataDir, "agent") }, stdio: "ignore" });
let browser;
try {
	for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
	const prompts = [];
	await page.routeWebSocket("**/ws", (socket) => {
		const upstream = socket.connectToServer();
		upstream.onMessage(raw => { const message = JSON.parse(String(raw)); if (message.type === "snapshot" || message.type === "snapshot_delta") message.state.piConfigured = true; socket.send(JSON.stringify(message)); });
		socket.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			// Hold prompts locally: exercise latency and failures without spending model tokens.
			if (message.type === "node_request" && message.action === "chat_prompt") prompts.push(message);
			else upstream.send(raw);
		});
	});
	const errors = []; page.on("pageerror", (e) => errors.push(e.message));
	page.on("dialog", (dialog) => dialog.accept());
	await page.goto(`http://127.0.0.1:${port}/`);
	// Main-window sidebar geometry is covered by the dedicated layout regressions.
	await page.setViewportSize({ width: 1500, height: 950 });
	await page.getByRole("tab", { name: "节点" }).click();
	await page.locator(".node-sidebar header button").click();
	await page.locator(".node-entry-options").getByRole("button", { name: /SSH/ }).click();
	const form = page.locator(".node-modal");
	await page.waitForFunction(() => document.querySelector('.node-modal')?.contains(document.activeElement));
	await form.getByRole('button', { name: '连接并保存', exact: true }).focus();
	await page.keyboard.press('Tab');
	assert(await form.evaluate(el => el.contains(document.activeElement)), 'node dialog must retain Tab focus');
	await page.keyboard.press('Shift+Tab');
	assert(await form.evaluate(el => el.contains(document.activeElement)), 'node dialog must retain reverse Tab focus');
	await form.locator("details > summary").click();
	await form.getByLabel("分组").fill("开发");
	await form.getByLabel("名称").fill("alpha");
	await form.getByLabel("地址").fill("127.0.0.1");
	await form.getByLabel("端口").fill(String(sshPort));
	await form.getByLabel("用户名").fill("tester");
	await form.getByLabel("默认目录").fill("/home/test");
	await form.locator('input[type="password"]').fill("secret123");
	await form.getByRole("button", { name: "连接并保存" }).click();
	await page.locator(".node-connection-tabs button", { hasText: "断开" }).waitFor({ timeout: 10000 });

	await page.locator(".node-tabs .active").waitFor({ state: "attached" });
	assert(await page.locator(".node-agent").count() === 1, "remote agent workbench missing");
	assert(await page.locator(".node-manual-workbench").isVisible(), "manual terminal must remain visible beside the agent");
	assert(prompts.length === 0, "opening nodes created an agent prompt");
	await page.locator(".node-agent-welcome").waitFor();
	const agentActions = page.locator(".node-agent > header .dropdown > button");
	await agentActions.click();
	await page.locator(".node-agent > header .dd-item").first().waitFor();
	await page.keyboard.press("Escape");
	assert(await agentActions.evaluate(el => el === document.activeElement), "closing session menu must restore keyboard focus");
	assert(await page.locator(".node-agent > header .dd-menu").count() === 0, "session menu must close on Escape");


	await page.locator(".node-xterm").first().click();
	await page.keyboard.type("hello"); await page.keyboard.press("Enter");
	await page.waitForFunction(() => document.querySelector(".node-xterm")?.textContent?.includes("echo:hello"), { timeout: 5000 });
	await page.getByRole("button", { name: "文件", exact: true }).click();
	await page.locator(".node-filebar button").click();
	await page.locator(".node-files", { hasText: "a.txt" }).waitFor();
	await page.locator(".node-files button", { hasText: "a.txt" }).click();
	await page.locator(".node-file-editor").waitFor();
	await page.getByRole("button", { name: "‹ 节点", exact: true }).click();
	await page.locator(".node-sidebar header button").click();
	await page.locator(".node-entry-options").getByRole("button", { name: /SSH/ }).click();
	const second = page.locator(".node-modal");
	await second.locator("details > summary").click();
	await second.getByLabel("分组").fill("测试");
	await second.getByLabel("名称").fill("beta");
	await second.getByLabel("地址").fill("127.0.0.1");
	await second.getByLabel("端口").fill(String(sshPort));
	await second.getByLabel("用户名").fill("tester");
	await second.locator('input[type="password"]').fill("secret123");
	await second.getByRole("button", { name: "连接并保存" }).click();
	await page.locator(".node-connection-tabs button", { hasText: "断开" }).waitFor({ timeout: 10000 });

	await page.locator(".node-xterm:visible").click();
	await page.keyboard.type("beta-command"); await page.keyboard.press("Enter");
	await page.waitForFunction(() => document.querySelector(".node-xterm")?.textContent?.includes("echo:beta-command"));
	await page.locator(".node-connection-tabs button", { hasText: "alpha" }).click();
	await page.waitForFunction(() => document.querySelector(".node-xterm")?.textContent?.includes("echo:hello"));
	assert(!(await page.locator(".node-xterm:visible").innerText()).includes("beta-command"), "terminal output leaked across nodes");
	await page.locator(".node-file-editor").getByRole("button", { name: "关闭", exact: true }).click();
	await page.screenshot({ path: join(root, "tests/scratch/node-workspace.png") });

	await page.getByRole("button", { name: "‹ 节点", exact: true }).click();
	await page.getByRole("button", { name: "管理来源", exact: true }).click();
	await page.locator(".node-entry-options").getByRole("button", { name: /Xshell/ }).click();
	const sourceDir = join(dataDir, "xshell-sessions"); mkdirSync(sourceDir);
	const sessionFile = join(sourceDir, "imported.xsh");
	const sourceText = `[CONNECTION]\nHost=127.0.0.1\nPort=${sshPort}\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=tester\nMethod=0\n`;
	writeFileSync(sessionFile, sourceText, "utf16le");
	// UTF-16 LE Xshell sessions use a BOM.
	writeFileSync(sessionFile, Buffer.concat([Buffer.from([255,254]), Buffer.from(sourceText, "utf16le")]));
	await page.locator(".node-modal").getByLabel("运行服务的机器上的配置路径").fill(sourceDir);
	await page.waitForFunction(() => !document.querySelector(".node-import-modal button[type=submit]")?.disabled);
	await page.locator(".node-import-modal button[type=submit]").click();
	await page.locator(".node-item", { hasText: "imported" }).getByRole("button").first().click();
	await page.screenshot({ path: join(root, "tests/scratch/node-details.png") });
	await page.getByRole("button", { name: "打开工作台", exact: true }).click();
	await page.locator(".node-modal").getByRole("combobox").selectOption("key");
	const importedKeyPath = join(dataDir, "imported_id_rsa"); writeFileSync(importedKeyPath, privateKey, { mode: 0o600 });
	await page.locator(".node-modal").getByLabel("本机私钥路径").fill(importedKeyPath);
	await page.locator(".node-modal").getByRole("button", { name: "测试并保存" }).click();
	await page.locator(".node-connection-tabs button", { hasText: "断开" }).waitFor({ timeout: 10000 });
	assert(await page.locator(".node-modal").count() === 0, "credential modal stayed open");
	await page.getByRole("button", { name: "‹ 节点", exact: true }).click();
	writeFileSync(join(sourceDir, "added.xsh"), sourceText);
	await page.waitForTimeout(5500);
	assert(await page.locator(".node-item", { hasText: "added" }).count() === 0, "unselected new sessions must not import automatically");
	writeFileSync(join(sourceDir, "public-key.xsh"), sourceText.replace("Method=0", "Method=1\nUserKey=xshell-key"));
	const keyPath = join(dataDir, "id_rsa"); writeFileSync(keyPath, privateKey, { mode: 0o600 });
	await page.getByRole("button", { name: "管理来源", exact: true }).click();
	await page.locator(".node-entry-options").getByRole("button", { name: /Xshell/ }).click();
	await page.locator(".node-import-modal").getByLabel("运行服务的机器上的配置路径").fill(sourceDir);
	await page.getByText("共 3 个会话 · 已选 3 个", { exact: true }).waitFor();
	await page.locator(".node-import-modal button[type=submit]").click();
	await page.locator(".node-item", { hasText: "public-key" }).getByRole("button").first().click({ timeout: 10000 });
	await page.getByRole("button", { name: "打开工作台", exact: true }).click();
	await page.locator(".node-modal").getByLabel("本机私钥路径").fill(keyPath);
	assert(!(await page.locator(".node-modal input[type=password]").evaluate((input) => input.required)), "key passphrase must be optional");
	await page.locator(".node-modal").getByRole("button", { name: "测试并保存" }).click();
	await page.locator(".node-connection-tabs button", { hasText: "断开" }).waitFor({ timeout: 10000 });
	await page.getByRole("button", { name: "‹ 节点", exact: true }).click();
	await page.getByRole("button", { name: "管理来源", exact: true }).click();
	await page.screenshot({ path: join(root, "tests/scratch/node-sources.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page overflows mobile width");
	await page.screenshot({ path: join(root, "tests/scratch/node-mobile.png") });
	assert(!errors.length, errors.join("\n"));
	console.log("✓ browser node groups, trust, terminals, SFTP and node switching isolation");
} finally {
	await browser?.close(); server.kill(); mock.close(); rmSync(dataDir, { recursive: true, force: true });
}
function assert(ok, message) { if (!ok) throw new Error(message); }
