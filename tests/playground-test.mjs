import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/** Start a Run and collect its events; resolves when the stream ends. */
async function run(code, { signal, client, origin } = {}) {
	const response = await fetch(`${base}/api/playground/run?token=${token}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(client ? { "x-pi-client": client } : {}), ...(origin ? { Origin: origin } : {}) },
		body: JSON.stringify({ code }),
		signal,
	});
	if (!response.ok) return { status: response.status, body: await response.json().catch(() => ({})), events: [] };
	const events = [];
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		for (let index = buffer.indexOf("\n\n"); index !== -1; index = buffer.indexOf("\n\n")) {
			const frame = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const line = frame.split("\n").find(part => part.startsWith("data: "));
			if (line) events.push(JSON.parse(line.slice(6)));
		}
	}
	return { status: response.status, events };
}
const text = (events, stream) => events.filter(event => event.type === "out" && event.stream === stream).map(event => event.text).join("");
const end = events => events.find(event => event.type === "end");
/** Temp directories a Run owns, to prove cleanup on every exit path. */
const runDirs = () => readdirSync(tmpdir()).filter(name => name.startsWith("pi-playground-")).length;
const HELLO = 'public class Main { public static void main(String[] args) { System.out.println("hello"); } }';

try {
	await start();

	// --- status -----------------------------------------------------------------
	assert.equal((await fetch(`${base}/api/playground/status`)).status, 401);
	assert.equal((await status("", { Origin: "https://evil.example" })).status, 403);
	assert.equal((await fetch(`${base}/api/playground/status?token=${token}`, { method: "POST" })).status, 405);

	const fresh = await (await status()).json();
	assert.equal(fresh.enabled, false, "the Playground must default to off");
	assert.equal(fresh.locked, false);
	assert.deepEqual(fresh.limits, { timeoutMs: 10000, maxOutputBytes: 262144, maxHeapMb: 256 });
	assert.equal(typeof fresh.jdk.available, "boolean");
	if (fresh.jdk.available) assert.match(String(fresh.jdk.version), /\d/);
	else assert.match(String(fresh.jdk.reason), /JDK/);
	assert.equal((await status("refresh=1")).status, 200);

	writeConfig({ enabled: true, timeoutMs: 30000 });
	const on = await (await status()).json();
	assert.equal(on.enabled, true);
	assert.equal(on.limits.timeoutMs, 30000);
	assert.equal(on.locked, false);

	writeConfig("{ broken");
	assert.equal((await (await status()).json()).enabled, false, "a corrupt config must not enable execution");
	writeConfig({ enabled: "yes" });
	assert.equal((await (await status()).json()).enabled, false, "a non-boolean enable must not enable execution");
	writeConfig({ enabled: true, timeoutMs: 999999 });
	assert.equal((await (await status()).json()).limits.timeoutMs, 60000, "stored limits are clamped");

	// --- gating -----------------------------------------------------------------
	writeConfig({ enabled: false });
	assert.equal((await run(HELLO)).status, 403, "a disabled Playground must refuse to run");
	writeConfig({ enabled: true, timeoutMs: 30000 });
	assert.equal((await run(HELLO, { origin: "https://evil.example" })).status, 403, "a foreign origin must be refused");
	assert.equal((await run("")).status, 400, "empty source is rejected");
	assert.equal((await run(123)).status, 400, "non-string source is rejected");
	assert.equal((await run("x".repeat(300000))).status, 400, "oversized source is rejected");

	// --- execution (needs a JDK) -------------------------------------------------
	const jdk = (await (await status()).json()).jdk;
	if (!jdk.available) {
		console.log(`SKIP playground run: no usable JDK on this machine (${jdk.reason})`);
	} else {
		const baseline = runDirs();

		const hello = await run(HELLO);
		assert.equal(hello.status, 200);
		assert.equal(hello.events[0].type, "start");
		assert.equal(text(hello.events, "stdout"), "hello\n");
		assert.deepEqual(end(hello.events), { type: "end", exitCode: 0, durationMs: end(hello.events).durationMs, truncated: false, timedOut: false, compileError: false });

		// stderr stays separate from stdout.
		const mixed = await run('public class Main { public static void main(String[] a) { System.out.println("out"); System.err.println("err"); } }');
		assert.equal(text(mixed.events, "stdout"), "out\n");
		assert.equal(text(mixed.events, "stderr"), "err\n");

		// A package declaration and a non-Main type name both work.
		const packaged = await run('package demo;\npublic class Greeter { public static void main(String[] a) { System.out.println("pkg"); } }');
		assert.equal(text(packaged.events, "stdout"), "pkg\n");
		assert.equal(end(packaged.events).exitCode, 0);

		// stdin is closed immediately, so a reading program ends instead of hanging.
		const stdin = await run('public class Main { public static void main(String[] a) throws Exception { System.out.println("read=" + System.in.read()); } }');
		assert.equal(text(stdin.events, "stdout"), "read=-1\n");

		// A compile failure is labelled as such and the program never runs.
		const compileFailure = await run("public class Main { this is not java }");
		assert.equal(end(compileFailure.events).compileError, true);
		assert.equal(end(compileFailure.events).exitCode === 0, false);
		assert.match(text(compileFailure.events, "stderr"), /error/);

		// A runtime failure is not a compile failure.
		const runtimeFailure = await run('public class Main { public static void main(String[] a) { throw new RuntimeException("boom"); } }');
		assert.equal(end(runtimeFailure.events).compileError, false);
		assert.equal(end(runtimeFailure.events).exitCode, 1);
		assert.match(text(runtimeFailure.events, "stderr"), /boom/);

		// The wall-clock timeout kills the process rather than waiting it out.
		writeConfig({ enabled: true, timeoutMs: 1000 });
		const before = Date.now();
		const timedOut = await run('public class Main { public static void main(String[] a) throws Exception { Thread.sleep(60000); } }');
		assert.equal(end(timedOut.events).timedOut, true);
		assert.ok(Date.now() - before < 15000, "a timed-out Run must be killed, not awaited");

		// Runaway output is cut off and kills the process.
		writeConfig({ enabled: true, timeoutMs: 30000, maxOutputBytes: 1024 });
		const flooded = await run('public class Main { public static void main(String[] a) { while (true) System.out.println("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); } }');
		assert.equal(end(flooded.events).truncated, true);
		assert.ok(text(flooded.events, "stdout").length <= 1200, "output past the cap must not be forwarded");

		// Concurrency: one Run at a time per client, and the global limit holds.
		writeConfig({ enabled: true, timeoutMs: 30000, maxConcurrent: 1 });
		const slow = run('public class Main { public static void main(String[] a) throws Exception { Thread.sleep(3000); } }');
		await sleep(400);
		assert.equal((await run(HELLO)).status, 429, "a second Run must be refused while one is in flight");
		await slow;

		// Cancelling kills the process and cleans up.
		writeConfig({ enabled: true, timeoutMs: 30000 });
		const controller = new AbortController();
		const cancelled = run('public class Main { public static void main(String[] a) throws Exception { Thread.sleep(60000); } }', { signal: controller.signal }).catch(() => ({ status: 0, events: [] }));
		await sleep(500);
		controller.abort();
		await cancelled;

		// Every exit path leaves the temp directory behind, never on disk.
		for (let i = 0; i < 40 && runDirs() > baseline; i++) await sleep(100);
		assert.equal(runDirs(), baseline, "Runs must clean up their temp directories");

		console.log("PASS playground run: stdout/stderr, package, stdin EOF, compile vs runtime failure, timeout, output cap, concurrency and cleanup");
	}

	// --- the environment switch --------------------------------------------------
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
