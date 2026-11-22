// macOS: run after npm run build:server and playwright-core install chromium.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { testEnv } from "./lib/test-env.mjs";

const root = mkdtempSync("/tmp/pi-reader-");
const env = testEnv({ HOME: root });
const profile = join(root, "profile");
const extension = join(root, "extension");
const fixture = createServer((req, res) => {
	res.setHeader("Content-Type", "text/html");
	const message = req.headers.cookie?.includes("session=fixture") ? "Signed in fixture sentence" : "Login";
	res.end("<title>Fixture Conversation</title><main>" + message + "</main>");
});

function invoke(name, args) {
	const script = `
		import { pageReader } from "./dist/server/page-reader.js";
		const tools = new Map();
		pageReader({registerTool: tool => tools.set(tool.name, tool)});
		const result = await tools.get(process.argv[1]).execute("test", JSON.parse(process.argv[2]));
		process.stdout.write(result.content[0].text);
	`;
	return execFileSync(process.execPath, ["--input-type=module", "-e", script, name, JSON.stringify(args)], { env, encoding: "utf8", stdio: "pipe" });
}

let context;
try {
	await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
	const url = "http://127.0.0.1:" + fixture.address().port;
	cpSync("assets/page-reader", extension, { recursive: true });
	// Pre-grant only the fixture site in this disposable copy. Exercise revocation via Chrome settings.
	const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
	manifest.host_permissions = ["http://127.0.0.1/*"];
	writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
	execFileSync(process.execPath, ["bin/page-reader-install.mjs"], { env });
	cpSync(join(root, "Library/Application Support/Google/Chrome/NativeMessagingHosts"), join(profile, "NativeMessagingHosts"), { recursive: true });
	context = await chromium.launchPersistentContext(profile, {
		env, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions"],
		args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension],
	});
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10000 });
	const admin = await context.newPage();
	await admin.goto("chrome://extensions");
	await context.addCookies([{name: "session", value: "fixture", url}]);
	const first = context.pages()[0];
	await first.goto(url + "/one");
	const second = await context.newPage();
	await second.goto(url + "/two");
	const hostDir = join(root, ".pi-harness-reader");
	for (let i = 0; i < 50 && !readdirSync(hostDir).some(file => file.endsWith(".sock")); i++) await delay(100);
	const pages = JSON.parse(invoke("page_reader_find", { query: "Fixture Conversation" }));
	assert.equal(pages.length, 2);
	const read = page => invoke("page_reader_read", { pageId: page.pageId });
	const selected = pages.find(page => page.url === first.url());
	assert.match(read(selected), /Signed in fixture sentence/);
	await first.locator("main").evaluate(main => { main.innerText = "A".repeat(61000); });
	assert.match(read(selected), /Loaded text \(truncated\):\n\nA{60000}$/);
	await first.locator("main").evaluate(main => { main.innerText = ""; });
	assert.throws(() => read(selected), /没有可读取/);
	await first.goto(url + "/different");
	assert.throws(() => read(selected), /重新查找/);
	await admin.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess: "ON_CLICK" }), new URL(worker.url()).hostname);
	assert.throws(() => read(pages.find(page => page.url === second.url())), /授权已撤销/);
	await context.close();
	context = undefined;
	assert.throws(() => invoke("page_reader_find", { query: "fixture" }), /未连接/);
	console.log("PASS signed-in page, multiple matches, navigation, revocation and disconnected Chrome");
} finally {
	await context?.close();
	fixture.close();
	rmSync(root, { recursive: true, force: true });
}
