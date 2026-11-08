/** Real browser, isolated transcript fixture; no model or external database calls. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
const root = mkdtempSync(join(tmpdir(), "pi-chat-find-"));
let server, browser;
try {
	server = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent") } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage(); page.setDefaultTimeout(10000);
	const errors = []; page.on("pageerror", error => errors.push(error.message));
	await page.routeWebSocket("**/ws", route => {
		const upstream = route.connectToServer();
		upstream.onMessage(wire => {
			const message = JSON.parse(String(wire));
			if (message.type === "snapshot") Object.assign(message.state, { piConfigured: true, isStreaming: false, streamingMessage: null, messages: [
				{ id: "question", role: "user", content: [{ type: "text", text: "Inspect the log" }] },
				{ id: "answer", role: "assistant", content: [{ type: "text", text: "alpha keyword\n\nalpha keyword" }] },
			] });
			if (message.type !== "snapshot_delta") route.send(JSON.stringify(message));
		});
	});
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.locator('[data-msg-id="answer"]').waitFor();
	await page.keyboard.press("Control+f");
	const input = page.locator(".search-input");
	await input.fill("alpha");
	await page.locator(".search-count", { hasText: "1/2" }).waitFor();
	for (const key of ["Enter", "Escape"]) {
		assert.equal(await input.evaluate((el, key) => {
			const event = new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, cancelable: true });
			el.dispatchEvent(event); return event.defaultPrevented;
		}, key), false);
		assert.equal(await input.count(), 1);
		assert.equal(await page.locator(".search-count").innerText(), "1/2");
	}
	await input.press("Enter");
	assert.equal(await page.locator(".search-count").innerText(), "2/2");
	await input.press("Escape");
	await input.waitFor({ state: "detached" });
	assert.deepEqual(errors, []);
	console.log("PASS chat find preserves IME keys and ordinary Enter/Escape behavior");
} finally {
	await browser?.close(); await server?.stop();
	rmSync(root, { recursive: true, force: true });
}
