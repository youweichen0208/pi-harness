/** Running text is not a settled task: exercise the real chat lifecycle presentation. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-working-text-"));
const user = { id: "user", role: "user", content: [{ type: "text", text: "Update the domain model" }] };
const answer = { id: "answer", role: "assistant", content: [{ type: "text", text: "Migration is valid. Now the domain model change." }] };
let harness, browser;
try {
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent") } });
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	page.setDefaultTimeout(5000);
	const errors = [];
	page.on("pageerror", error => errors.push(error.message));
	let socket, baseline;
	let overrides = { messages: [user, answer], isStreaming: true, streamingMessage: null, piConfigured: true };
	await page.routeWebSocket("**/ws", route => {
		socket = route;
		const upstream = route.connectToServer();
		route.onMessage(raw => upstream.send(raw));
		upstream.onMessage(raw => {
			const message = JSON.parse(String(raw));
			if (message.type === "snapshot") {
				baseline = message.state;
				message.state = { ...baseline, ...overrides };
			} else if (message.type === "snapshot_delta") return;
			route.send(JSON.stringify(message));
		});
	});
	const emit = patch => {
		overrides = { ...overrides, ...patch };
		baseline = { ...baseline, rev: baseline.rev + 1 };
		socket.send(JSON.stringify({ type: "snapshot", state: { ...baseline, ...overrides } }));
	};
	await page.goto(`http://127.0.0.1:${harness.port}`);
	const working = page.locator(".trailing-working .waiting-indicator");
	await working.filter({ hasText: "工作中" }).waitFor();
	assert.equal(await working.locator(".waiting-brand i").count(), 3);
	// A persisted paragraph and an actively streaming paragraph both retain the cue.
	emit({ messages: [user], streamingMessage: answer });
	await working.filter({ hasText: "工作中" }).waitFor();
	emit({ streamingMessage: { ...answer, content: [{ type: "text", text: "Now updating the domain model." }] } });
	await working.filter({ hasText: "工作中" }).waitFor();
	mkdirSync("tests/scratch", { recursive: true });
	await page.screenshot({ path: "tests/scratch/working-after-text.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await working.waitFor();
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	// Native settle/abort clears the indicator even when the final text stays on screen.
	emit({ isStreaming: false, messages: [user, answer], streamingMessage: null });
	await working.waitFor({ state: "detached" });
	emit({ isStreaming: true, messages: [user], streamingMessage: { id: "thinking", role: "assistant", content: [{ type: "thinking", thinking: "Checking constraints" }] } });
	await page.locator(".thinking.live").waitFor();
	assert.equal(await working.count(), 0, "visible thinking has its own progress cue");
	// Switching to an idle conversation must not inherit the old run's cue.
	emit({ conversationId: "other", isStreaming: false, messages: [user, answer], streamingMessage: null });
	await working.waitFor({ state: "detached" });
	assert.deepEqual(errors, []);
	console.log("PASS running persisted/streaming text keeps Working; settle, thinking and conversation switch clear it");
} finally {
	await browser?.close(); await harness?.stop(); rmSync(root, { recursive: true, force: true });
}
