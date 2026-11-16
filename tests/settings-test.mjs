// Native resource views and display-only preferences; zero model calls.
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIsolatedHarness } from "./lib/isolated-server.mjs";
import { mergeSnapshot } from "./lib/snapshots.mjs";
import { testEnv } from "./lib/test-env.mjs";

let harness;
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-set-test-"));
console.log("data-dir:", DATA_DIR);
const agent = join(DATA_DIR, "omp/agent"), cwd = join(DATA_DIR, "workspace");
const extensionRoot = join(agent, "extensions");
mkdirSync(cwd);
mkdirSync(join(extensionRoot, "sample-directory"), { recursive: true });
writeFileSync(join(extensionRoot, "sample-directory", "index.ts"), "export default function () {}\n");
writeFileSync(join(extensionRoot, "custom-footer.ts"), "export default function () {}\n");

writeFileSync(join(agent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
const env = testEnv({ PI_WEB_DATA_DIR: DATA_DIR, PI_WEB_CWD: cwd });
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = undefined;
		ws.on("message", (d) => { const event = JSON.parse(d.toString()); this.received.push(event); this.state = mergeSnapshot(this.state, event); });
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	/** Wait for a message; optional predicate. `type` may be an array of
	 *  acceptable types (snapshot OR snapshot_delta — incremental snapshots
	 *  mean post-action checkpoints often arrive as deltas). Unmatched older
	 *  settings frames are consumed while scanning. */
	async waitFor(type, timeout = 30000, pred) {
		const start = Date.now();
		const types = Array.isArray(type) ? type : [type];
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (!types.includes(m.type)) continue;
				this.received.splice(i, 1);
				if (!pred || pred(m)) return m;
				i--;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
}

async function connect() {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	const client = new Client(ws);
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	return client;
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name} ${extra}`);
	}
}

let c;
try {
	harness = await startIsolatedHarness({ env });
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor(["snapshot", "snapshot_delta"], 8000, m => !!m.state?.sessionId);
	c.received = c.received.filter(m => m.type !== "settings_state");
	c.send({ type: "get_settings" });
	const st0 = await c.waitFor("settings_state");
	check("settings_state pushed on attach", !!st0.settings);
	check("has skills array", Array.isArray(st0.settings.skills));
	check("has extensions array", Array.isArray(st0.settings.extensions));
	check("no bundled todo", !st0.settings.extensions.some(e => e.builtin === "todo"));
	check("native directory extension loaded", st0.settings.extensions.some(e => e.path.replaceAll("\\", "/").includes("/sample-directory/") && e.enabled));
	check("native standalone extension loaded", st0.settings.extensions.some(e => e.name === "custom-footer.ts" && e.enabled));
	check("native prompt available", typeof st0.settings.effectiveSystemPrompt === "string" && st0.settings.effectiveSystemPrompt.length > 0);
	for (const field of ["promptMode", "customSystemPrompt", "terminalToolsEnabled", "visionBridgeEnabled", "presets"]) check(`${field} removed`, !(field in st0.settings));
	const originalPrompt = st0.settings.effectiveSystemPrompt;
	c.send({ type: "set_settings", thinkingWrap: true, toolsWrap: false, promptMode: "replace", customSystemPrompt: "HOST_OVERRIDE_SENTINEL" });
	const st1 = await c.waitFor("settings_state", 8000, m => m.settings.thinkingWrap === true);
	check("display preferences round-trip", st1.settings.toolsWrap === false);
	check("legacy prompt override ignored", st1.settings.effectiveSystemPrompt === originalPrompt);
	c.ws.close();
	await sleep(300);
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor(["snapshot", "snapshot_delta"]);
	const st9 = await c.waitFor("settings_state");
	check("display preferences survive reconnect", st9.settings.thinkingWrap === true && st9.settings.toolsWrap === false);
	check("native prompt survives reconnect", st9.settings.effectiveSystemPrompt === originalPrompt);

	// Explicit native resource reload must discover a newly added module.
	const sessionId = c.state.sessionId;
	writeFileSync(join(extensionRoot, "new-module.ts"), "export default function () {}\n");
	c.received = c.received.filter(message => message.type !== "settings_state");
	c.send({ type: "extensions_reload" });
	const reloaded = await c.waitFor("settings_state", 30000, message => message.settings.extensions.some(extension => extension.name === "new-module.ts"));
	check("extensions_reload discovers new native module", reloaded.settings.extensions.some(extension => extension.name === "new-module.ts" && extension.enabled));
	check("resource reload preserves display preferences", reloaded.settings.thinkingWrap === true && reloaded.settings.toolsWrap === false);
	check("resource reload preserves session identity", c.state.sessionId === sessionId);

	c.ws.close();

	console.log(`\n${pass} passed, ${fail} failed`);
} catch (err) {
	console.error("TEST ERROR:", err.message);
	fail++;
} finally {
	c?.ws.terminate();
	await harness?.stop();
	rmSync(DATA_DIR, { recursive: true, force: true });
}
process.exitCode = fail > 0 ? 1 : 0;
