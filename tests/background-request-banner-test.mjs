// Issue #140: background extension requests must not overlap or overflow.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-background-banner-"));
const cwd = join(root, "work"), agent = join(root, "agent");
for (const path of [cwd, agent]) mkdirSync(path);
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "unused", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 1024 }] } } }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "unused" } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
let harness, browser;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors = [], outgoing = [];
	let onSent = () => {};
	page.on("pageerror", error => errors.push(error.message));
	let wire, upstream;
	await page.routeWebSocket("**/ws", route => {
		wire = route; upstream = route.connectToServer();
		route.onMessage(raw => {
			const message = JSON.parse(String(raw)); outgoing.push(message); onSent(message);
			upstream.send(raw);
		});
		upstream.onMessage(raw => route.send(raw));
	});
	await page.goto(`http://127.0.0.1:${harness.port}`);
	const input = page.locator(".inputbar textarea");
	await input.waitFor();
	await page.waitForFunction(() => !document.querySelector(".inputbar textarea")?.disabled);
	const title = '你说的 windows host 是指什么？上一条 MR 保留分支与入库审核 '.repeat(20);
	for (const id of ["background-one", "background-two"]) wire.send(JSON.stringify({ type: "dialog", id, conversationId: id, source: "investigate", title, kind: "confirm" }));
	const banners = page.locator(".protocol-banner");
	await banners.nth(1).waitFor();
	const first = await banners.nth(0).boundingBox(), second = await banners.nth(1).boundingBox();
	assert(first && second && second.y >= first.y + first.height, "background requests must not overlap");
	assert(first.x >= 0 && first.x + first.width <= 1280, "long titles must stay inside viewport");
	mkdirSync("tests/scratch", { recursive: true });
	await page.screenshot({ path: "tests/scratch/issue-140-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	await page.screenshot({ path: "tests/scratch/issue-140-mobile.png" });
	const switched = new Promise(resolve => {
		const listener = message => {
			if (message.type === "switch_conversation" && message.id === "background-one") resolve();
		};
		onSent = listener;
	});
	await banners.first().click({ position: { x: 20, y: 20 } });
	await Promise.race([switched, new Promise((_, reject) => setTimeout(() => reject(Error("No conversation switch")), 3000))]);
	assert(outgoing.some(message => message.type === "switch_conversation" && message.id === "background-one"));
	assert.deepEqual(errors, []);
	console.log("PASS long background requests wrap, stack, scroll and retain conversation navigation");
} finally {
	await browser?.close(); await harness?.stop(); rmSync(root, { recursive: true, force: true });
}
