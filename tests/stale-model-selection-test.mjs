import { mergeSnapshot } from "./lib/snapshots.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { testEnv } from "./lib/test-env.mjs";

const root = mkdtempSync(join(tmpdir(), "stale-model-"));
const agent = join(root, "data/omp/agent");
mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, "config.yml"), JSON.stringify({ model: "fixture/stale", skills: { enabled: false }, cacheWarming: { enabled: false } }));
let calls = 0;
const provider = createServer((req, res) => { calls++; req.resume(); res.writeHead(500); res.end("This test must not call a model"); });
const wait = async predicate => { for (let i = 0; i < 1200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error("Timed out"); };

let harness, browser;
try {
	const port = await listenIsolated(provider);
	const saveModels = models => writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "anthropic-messages", baseUrl: `http://127.0.0.1:${port}`, apiKey: "fixture", models: models.map(id => ({ id, name: id === "stale" ? "Stale model" : "Working model", contextWindow: 32000 })) } } }));
	saveModels(["stale", "working"]);
	const env = testEnv({
		PI_WEB_CWD: root,
		PI_WEB_DATA_DIR: join(root, "data"),
	});
	for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
	harness = await startIsolatedHarness({ env });
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
	const page = await browser.newPage();
	const errors = [];
	let upstream, state, models = [], ready = false;
	const sent = [], received = [];
	await page.routeWebSocket("**/ws", route => {
		upstream = route.connectToServer();
		route.onMessage(wire => { sent.push(JSON.parse(String(wire))); upstream.send(wire); });
		upstream.onMessage(wire => {
			const event = JSON.parse(String(wire)); received.push(event);
			state = mergeSnapshot(state, event);
			if (event.type === "models") models = event.models;
			if (event.type === "ready") ready = true;
			route.send(wire);
		});
	});
	page.on("pageerror", error => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${harness.port}`);
	await wait(() => ready && models.some(model => model.id === "fixture/working"));
	await page.locator('.input-tools .chip-model').click();
	await page.locator('.dd-menu-model .dd-item').filter({ hasText: 'Stale model' }).click();
	await wait(() => state?.model?.id === "stale");
	saveModels(["working"]); upstream.send(JSON.stringify({ type: "list_models" }));
	await wait(() => models.length === 1 && models[0].id === "fixture/working");
	const picker = page.locator(".input-tools .chip-model-unavailable");
	await picker.waitFor();
	assert.match(await picker.innerText(), /Stale model/i);
	assert(await page.locator(".composer-model-warning").isVisible());
	const input = page.locator(".inputbox textarea").first();
	await input.fill("keep this draft");
	assert(await page.locator(".composer-action.send").first().isDisabled());
	await input.press("Enter");
	assert.equal(await input.inputValue(), "keep this draft");
	assert(!sent.some(event => event.type === "prompt"));
	await input.fill("/context");
	assert(await page.locator(".composer-action.send").isEnabled(), "native commands remain available with a stale model");
	await page.locator(".composer-action.send").click();
	await wait(() => received.some(event => event.type === "prompt_result" && event.commandExecuted));
	await page.locator(".omp-command-output pre").waitFor();
	await wait(() => !state.isStreaming);
	assert(!state.model || state.model.id === "stale", "local commands cannot silently choose a replacement model");
	await input.fill("keep this draft");
	await page.locator('.input-tools .chip-model').click();
	await page.locator(".dd-menu-model .dd-item").filter({ hasText: "Working model" }).click();
	await picker.waitFor({ state: "detached" });
	await wait(() => state.model?.id === "working");
	assert(await page.locator(".composer-action.send").first().isEnabled());
	assert.equal(await page.evaluate(() => localStorage.getItem("pi-preferred-chat-model")), "fixture/working");
	assert.equal(await input.inputValue(), "keep this draft");
	writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: {} }));
	upstream.send(JSON.stringify({ type: "list_models" }));
	await wait(() => models.length === 0);
	assert(!state.model || state.model.id === "working");
	assert(await page.locator(".composer-action.send").isDisabled(), "an empty catalogue cannot make a removed model usable");
	assert.equal(calls, 0, "catalog refresh, native commands and selection never invoke a model");
	assert.deepEqual(errors, []);
	console.log("PASS OMP stale model: visible warning, send blocked, local command allowed, draft retained, explicit switch restores send, empty catalogue stays blocked");
} finally {
	await browser?.close();
	await harness?.stop();
	provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
