/** Real browser, SDK and local SSE: recovery settings/status in both languages. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-recovery-ui-")), agent = join(root, "agent");
mkdirSync(agent);
const calls = new Map(), timers = new Set();
let browser, harness, fixtureError, currentPage;
const chunk = (res, delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
function finish(res, text, reason) {
	chunk(res, { content: text }); chunk(res, {}, reason); res.end("data: [DONE]\n\n");
}
async function waitCalls(name, expected) {
	const deadline = Date.now() + 20000;
	while ((calls.get(name) ?? 0) < expected) {
		if (fixtureError) throw fixtureError;
		if (Date.now() >= deadline) throw Error(`Timed out waiting for ${name} request ${expected}`);
		await sleep(20);
	}
}
const model = createServer((req, res) => { void (async () => {
	let raw = ""; for await (const part of req) raw += part;
	const body = JSON.parse(raw);
	const text = body.messages.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
	const name = [...text.matchAll(/CASE:([a-z_]+)/g)].at(-1)?.[1];
	assert(name, "request retains its user task");
	const count = (calls.get(name) ?? 0) + 1; calls.set(name, count);
	res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
	if (name.endsWith("exhaust")) return finish(res, `Part ${count}: the request lifecycle has more evidence to document in the next section.`, "length");
	if (name.endsWith("length") && count === 1) return finish(res, "The first section describes the request lifecycle and the remaining investigation.", "length");
	if (name.endsWith("repetition") && count === 1) {
		const timer = setInterval(() => chunk(res, { content: "UI_REPEAT_POISON Emit.\n".repeat(8) }), 15); timers.add(timer);
		res.once("close", () => { clearInterval(timer); timers.delete(timer); }); return;
	}
	chunk(res, { content: "Recovery continues from the previous result. Waiting for the next fixture action." });
})().catch(error => { fixtureError ??= error; res.destroy(error); }); });

try {
	const port = await listenIsolated(model);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "fixture", models: [{ id: "fixture", name: "Recovery fixture", input: ["text"], contextWindow: 1000000, maxTokens: 128000 }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
	writeFileSync(join(agent, "webui-extensions.json"), JSON.stringify({ autoCheck: false }));
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: root, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent } });
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	for (const locale of ["zh", "en"]) {
		const context = await browser.newContext({ viewport: { width: 1100, height: 844 } });
		await context.addInitScript(locale => localStorage.setItem("pi-harness:lang", locale), locale);
		const page = await context.newPage();
		currentPage = page;
		const errors = []; page.on("pageerror", error => errors.push(error.message));
		await page.goto(`http://127.0.0.1:${harness.port}`);
		const input = page.locator(".inputbox textarea");
		await input.waitFor();
		await page.locator(".input-tools .dropdown").filter({ has: page.locator(".chip-model") }).getByRole("button").first().click();
		const menu = page.locator(".dd-menu-model");
		await menu.locator("summary").click();
		const protection = menu.getByRole("checkbox", { name: locale === "zh" ? "重复输出保护" : "Repetition protection", exact: true });
		assert(await protection.isChecked(), "new conversation enables protection");
		await protection.click(); await page.waitForFunction(element => !element.checked, await protection.elementHandle());
		await protection.click(); await page.waitForFunction(element => element.checked, await protection.elementHandle());
		await page.setViewportSize({ width: 390, height: 844 });
		await protection.scrollIntoViewIfNeeded();
		await page.screenshot({ path: `/tmp/pi-run-recovery-ui-${locale}-settings.png` });
		await page.keyboard.press("Escape");
		const status = page.locator(".run-recovery-status");
		for (const scenario of process.argv.includes("--length-only") ? ["length"] : ["length", "repetition"]) {
			await input.fill("/new "); await page.locator(".composer-action.send").click();
			await page.waitForFunction(() => { const input = document.querySelector(".inputbox textarea"); return input && !input.disabled && input.value === ""; });
			await input.fill(`CASE:${locale}_${scenario} Complete the investigation.`); await page.locator(".composer-action.send").click();
			await waitCalls(`${locale}_${scenario}`, 2);
			await page.locator(`.run-recovery-status[data-recovery-reason="${scenario}"][data-recovery-phase="recovering"]`).waitFor();
			assert.match(await status.innerText(), /1\/[12]/);
			assert(await status.getByRole("button", { name: locale === "zh" ? "停止" : "Stop", exact: true }).isEnabled());
			await page.locator(".tool-reminder-event").filter({ hasText: locale === "zh" ? scenario === "length" ? "自动续接" : "自动恢复" : scenario === "length" ? "Continued automatically" : "Automatic recovery started" }).last().waitFor();
			await page.screenshot({ path: `/tmp/pi-run-recovery-ui-${locale}-${scenario}.png` });
			await status.getByRole("button").click();
			await page.locator('.run-recovery-status[data-recovery-phase="stopped"]').waitFor();
			await page.locator(".composer-action.stop").waitFor({ state: "hidden" });
			assert.equal(await status.getByRole("button").count(), 0);
			assert.equal(calls.get(`${locale}_${scenario}`), 2);
		}
		await input.fill(`CASE:${locale}_exhaust Complete the report.`); await page.locator(".composer-action.send").click();
		await waitCalls(`${locale}_exhaust`, 3);
		await page.locator('.run-recovery-status[data-recovery-reason="length"][data-recovery-phase="stopped"]').filter({ hasText: /2\/2/ }).waitFor();
		assert.match(await status.innerText(), /2\/2/);
		assert.match(await status.innerText(), locale === "zh" ? /自动恢复上限/ : /recovery limit reached/);
		assert.equal(await status.getByRole("button").count(), 0);
		assert.equal(calls.get(`${locale}_exhaust`), 3);
		await page.screenshot({ path: `/tmp/pi-run-recovery-ui-${locale}-exhausted.png` });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "narrow viewport has no horizontal overflow");
		assert.deepEqual(errors, []);
		await context.close();
		console.log(`PASS ${locale}: protection toggle, recovery event/stop, exhausted state, 390px screenshots${process.argv.includes("--length-only") ? " (length only)" : " (length and repetition)"}`);
	}
	if (fixtureError) throw fixtureError;
} catch (error) {
	console.error("Fixture calls:", Object.fromEntries(calls), "Fixture error:", fixtureError?.message);
	if (currentPage && !currentPage.isClosed()) {
		await currentPage.screenshot({ path: "/tmp/pi-run-recovery-ui-failure.png" });
		console.error("Visible recovery:", await currentPage.locator(".run-recovery-status, .notice, .protocol-banner").allTextContents());
	}
	throw error;
} finally {
	for (const timer of timers) clearInterval(timer);
	await browser?.close(); await harness?.stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
