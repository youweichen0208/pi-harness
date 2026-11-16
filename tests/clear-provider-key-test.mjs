/** Built-in keys use OMP's credential store; clear is idempotent and provider-scoped. */
import assert from "node:assert/strict";
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
import { testEnv } from "./lib/test-env.mjs";

const root = mkdtempSync(join(tmpdir(), "omp-clear-key-"));
const dataDir = join(root, "data"), agent = join(dataDir, "omp/agent"), cwd = join(root, "work");
for (const dir of [agent, cwd]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
// Clearing stored keys must leave the separate models.yml authentication intact.
const config = JSON.stringify({ providers: { fixture: { api: "anthropic-messages", baseUrl: "http://127.0.0.1:1", apiKey: "FIXTURE_CONFIG_KEY", models: [{ id: "fixture" }] } } });
writeFileSync(join(agent, "models.yml"), config);
const env = testEnv({ PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: cwd });
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
// A known fixture env key remains available when no stored key exists.
env.MISTRAL_API_KEY = "FIXTURE_ENV_KEY";
let harness, ws;
let received = [], allReceived = [];
const send = message => ws.send(JSON.stringify(message));
async function waitFor(type, predicate = () => true) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		const index = received.findIndex(event => event.type === type && predicate(event));
		if (index >= 0) return received.splice(index, 1)[0];
		// Exercise actions while asynchronous initial metadata may still be arriving.
		await sleep(1);
	}
	throw Error(`Timed out waiting for ${type}; received ${received.map(event => event.type).join(",")}`);
}
async function connect() {
	received = [];
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	ws.on("message", data => { const event = JSON.parse(String(data)); received.push(event); allReceived.push(event); });
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	send({ type: "hello", clientId: "clear-key" });
	await waitFor("ready");
	// ready does not await the asynchronous initial model catalogue.
	received = [];
}
async function action(type, provider, apiKey) {
	received = [];
	send({ type, provider, ...(apiKey === undefined ? {} : { apiKey }) });
	const status = await waitFor("providers_status");
	// The handler sends its refreshed models before providers_status. An earlier
	// initial catalogue may also be queued; the UI applies the latest frame.
	const models = received.filter(event => event.type === "models").at(-1);
	assert(models, "credential mutation must publish models before provider status");
	assert(!received.some(event => event.type === "notice" && event.level === "error"));
	return { provider: status.providers.find(item => item.id === provider), models: models.models };
}
function configured(result, id, expected, source) {
	assert.equal(result.provider?.configured, expected, id);
	if (source) assert.equal(result.provider.source, source, id);
	assert.equal(result.models.some(model => model.provider === id), expected, `picker availability: ${id}`);
}
try {
	harness = await startIsolatedHarness({ env }); await connect();
	configured(await action("set_provider_api_key", "deepseek", "FIXTURE_DEEPSEEK_KEY"), "deepseek", true, "stored");
	assert(existsSync(join(agent, "agent.db")), "native credential database exists");
	assert(!existsSync(join(agent, "auth.json")), "no retired Pi credential file is created");
	configured(await action("clear_provider_api_key", "deepseek"), "deepseek", false);
	configured(await action("clear_provider_api_key", "deepseek"), "deepseek", false);
	configured(await action("set_provider_api_key", "openai", "FIXTURE_OPENAI_KEY"), "openai", true, "stored");
	configured(await action("set_provider_api_key", "anthropic", "FIXTURE_ANTHROPIC_KEY"), "anthropic", true, "stored");
	const cleared = await action("clear_provider_api_key", "openai");
	configured(cleared, "openai", false);
	assert(cleared.models.some(model => model.provider === "anthropic"), "other provider remains usable");
	configured(await action("clear_provider_api_key", "mistral"), "mistral", true, "environment");
	configured(await action("clear_provider_api_key", "fixture"), "fixture", true, "models_json_key");
	assert.equal(readFileSync(join(agent, "models.yml"), "utf8"), config);
	ws.terminate(); await harness.stop();
	harness = await startIsolatedHarness({ env }); await connect();
	send({ type: "list_providers" });
	const status = await waitFor("providers_status");
	for (const id of ["deepseek", "openai"]) assert.equal(status.providers.find(provider => provider.id === id).configured, false, `clear persists after restart: ${id}`);
	assert.equal(status.providers.find(provider => provider.id === "anthropic").source, "stored");
	assert.equal(status.providers.find(provider => provider.id === "anthropic").configured, true);
	assert(!JSON.stringify(allReceived).includes("FIXTURE_"), "keys never appear in any server frame");
	assert(!allReceived.some(event => event.type === "notice" && event.level === "error"));
	console.log("PASS OMP keys over WebSocket: save/clear, picker availability, idempotency, unrelated/env/config credentials preserved, native persistence after restart, no secret echo");
} finally {
	ws?.terminate(); await harness?.stop(); rmSync(root, { recursive: true, force: true });
}
