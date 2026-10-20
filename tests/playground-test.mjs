import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

// Self-contained: own port (>= 8900) and own data dir, so it can run beside the
// other suite scripts and never touches the developer's real ~/.pi-web.
const root = mkdtempSync(join(tmpdir(), "pi-playground-api-"));
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
assert(port >= 8900);

const base = `http://127.0.0.1:${port}`;
const token = "playground-test-only";
const dataDir = join(root, "data");
const configFile = join(dataDir, "playground.json");
let server, logs = "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(extraEnv = {}) {
	server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_TOKEN: token, PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_CWD: root, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
	server.stdout.on("data", data => { logs += data; }); server.stderr.on("data", data => { logs += data; });
	for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {} if (server.exitCode !== null) break; await sleep(100); }
	throw new Error(logs);
}
async function stop() {
	if (server?.exitCode === null) {
		server.kill("SIGTERM");
		await Promise.race([new Promise(resolve => server.once("exit", resolve)), sleep(5000)]);
		if (server.exitCode === null) { server.kill("SIGKILL"); await new Promise(resolve => server.once("exit", resolve)); }
	}
}
async function status(query = "", headers = {}) {
	return fetch(`${base}/api/playground/status?${query ? `${query}&` : ""}token=${token}`, { headers });
}
function writeConfig(value) { mkdirSync(dataDir, { recursive: true }); writeFileSync(configFile, typeof value === "string" ? value : JSON.stringify(value)); }

try {
	await start();

	// Auth and same-origin, same as every other /api route.
	assert.equal((await fetch(`${base}/api/playground/status`)).status, 401);
	assert.equal((await status("", { Origin: "https://evil.example" })).status, 403);
	assert.equal((await fetch(`${base}/api/playground/status?token=${token}`, { method: "POST" })).status, 405);

	// A fresh install: off, unlocked, documented limits, and an honest JDK answer.
	const fresh = await (await status()).json();
	assert.equal(fresh.enabled, false, "the Playground must default to off");
	assert.equal(fresh.locked, false);
	assert.deepEqual(fresh.limits, { timeoutMs: 10000, maxOutputBytes: 262144, maxHeapMb: 256 });
	assert.equal(typeof fresh.jdk.available, "boolean");
	if (fresh.jdk.available) assert.match(String(fresh.jdk.version), /\d/);
	else assert.match(String(fresh.jdk.reason), /JDK/);

	// Re-detect is an explicit refresh of the same endpoint.
	assert.equal((await status("refresh=1")).status, 200);

	// The file is the switch.
	writeConfig({ enabled: true, timeoutMs: 30000 });
	const on = await (await status()).json();
	assert.equal(on.enabled, true);
	assert.equal(on.limits.timeoutMs, 30000);
	assert.equal(on.locked, false);

	// A corrupt or hand-edited file fails closed, not open.
	writeConfig("{ broken");
	assert.equal((await (await status()).json()).enabled, false, "a corrupt config must not enable execution");
	writeConfig({ enabled: "yes" });
	assert.equal((await (await status()).json()).enabled, false, "a non-boolean enable must not enable execution");
	writeConfig({ enabled: true, timeoutMs: 999999 });
	assert.equal((await (await status()).json()).limits.timeoutMs, 60000, "stored limits are clamped");

	// The environment switch overrides the file and locks the setting.
	writeConfig({ enabled: true });
	await stop();
	await start({ PI_WEB_PLAYGROUND: "off" });
	const locked = await (await status()).json();
	assert.equal(locked.locked, true);
	assert.equal(locked.enabled, false, "the environment switch must override an enabled config file");

	console.log("PASS playground API: auth, origin, default-off, limits, corrupt-config fail-closed, clamping and the environment lock");
} finally {
	await stop();
	rmSync(root, { recursive: true, force: true });
}
