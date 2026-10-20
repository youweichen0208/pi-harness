import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
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
	server = spawn(process.execPath, ["dist/server/index.js"], { env: testEnv({ PORT: String(port), PI_WEB_TOKEN: token, PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_CWD: root, ...extraEnv }), stdio: ["ignore", "pipe", "pipe"] });
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
/** Write the global switch. Returns the response, so callers can assert refusals. */
async function configure(body, headers = {}) {
	return fetch(`${base}/api/playground/config?token=${token}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function writeConfig(value) { mkdirSync(dataDir, { recursive: true }); writeFileSync(configFile, typeof value === "string" ? value : JSON.stringify(value)); }

/**
 * Strip every inherited PI_* variable before spawning the server.
 *
 * Running the suite from inside a pi-harness/Electron host otherwise leaks the
 * host's own state into the test server: PI_WEB_PKG_ROOT makes it serve that
 * host's web/dist (so the browser is tested against the wrong UI entirely), and
 * PI_WEB_WORKSPACES_FILE / PI_SESSION_FILE point at the developer's real
 * projects and session. The test must only ever see what it sets here.
 */
function testEnv(extra) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("PI_")) delete env[key];
	return { ...env, ...extra };
}

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
/** The same rule the server uses to explain a project-dependency failure. */
const looksLikeMissingProjectDependency = output => /\bpackage\s+[\w.]+\s+does not exist\b/.test(output) || /cannot find symbol[\s\S]{0,400}?\bsymbol:\s*(?:class|interface|enum|record)\b/.test(output);
/** Temp directories a Run owns, to prove cleanup on every exit path. */
const runDirs = () => readdirSync(tmpdir()).filter(name => name.startsWith("pi-playground-")).length;
/** Poll the status endpoint until it satisfies a predicate. */
async function untilStatus(predicate, what) {
	for (let i = 0; i < 60; i++) {
		if (predicate(await (await status()).json())) return;
		await sleep(200);
	}
	throw new Error(`status never became: ${what}`);
}
const HELLO = 'public class Main { public static void main(String[] args) { System.out.println("hello"); } }';

// A local OpenAI-compatible provider, so the browser flow costs no tokens: the
// first turn asks for a bash call (to prove tool cards gain no Run control), the
// second returns the Java block the control is meant to attach to.
const REPLY = `Here you go:\n\n\`\`\`java\n${HELLO}\n\`\`\``;
const modelCalls = [];
const model = createHttpServer(async (req, res) => {
	let raw = "";
	for await (const chunk of req) raw += chunk;
	try { modelCalls.push(JSON.parse(raw)); } catch { modelCalls.push({}); }
	const delta = modelCalls.length === 1
		? { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo java-snippet" }) } }] }
		: { content: REPLY };
	res.writeHead(200, { "content-type": "text/event-stream" });
	// finish_reason must arrive as its own final chunk for the same choice index;
	// folding it into a second choice leaves the SDK thinking the stream never ended.
	const finish = modelCalls.length === 1 ? "tool_calls" : "stop";
	res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
	res.end("data: [DONE]\n\n");
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
// A real-looking provider so the one-time setup modal does not block the UI.
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "dummy" } }));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { test: { api: "openai-completions", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "dummy", models: [{ id: "test-model" }] } } }));

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

	// --- the settings write path -------------------------------------------------
	writeConfig({});
	const saved = await (await configure({ enabled: true, timeoutMs: 5000 })).json();
	assert.equal(saved.enabled, true);
	assert.equal(saved.limits.timeoutMs, 5000);
	// It persists, and it is the same answer the status endpoint gives.
	assert.equal((await (await status()).json()).enabled, true);
	assert.equal(JSON.parse(readFileSync(configFile, "utf8")).timeoutMs, 5000);

	// A partial write leaves everything else alone.
	const partial = await (await configure({ timeoutMs: 20000 })).json();
	assert.equal(partial.enabled, true, "a partial write must not reset the switch");
	assert.equal(partial.limits.timeoutMs, 20000);

	// Out-of-range values are clamped, exactly as they are when read.
	assert.equal((await (await configure({ timeoutMs: 999999 })).json()).limits.timeoutMs, 60000);

	// Wrong types are refused rather than silently reset to a default: a write
	// that quietly changes something else is worse than a rejected write.
	assert.equal((await configure({ enabled: "yes" })).status, 400);
	assert.equal((await configure({ timeoutMs: "5000" })).status, 400);
	assert.equal((await configure({ maxHeapMb: null })).status, 400);
	assert.equal((await configure({ unknownField: 1 })).status, 400);
	assert.equal((await configure({})).status, 400, "an empty write is a mistake, not a no-op");
	assert.equal((await configure({ enabled: true }, { Origin: "https://evil.example" })).status, 403);
	assert.equal((await fetch(`${base}/api/playground/config?token=${token}`)).status, 405);
	// The refused writes changed nothing.
	assert.equal((await (await status()).json()).limits.timeoutMs, 60000);

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
		// English, whatever the host locale: the diagnostics are parsed, not just shown.
		assert.match(text(compileFailure.events, "stderr"), /error:/);

		// A snippet that needs the rest of the project is recognisable, which is what
		// lets the file-preview entry explain the single-file limitation.
		const needsProject = await run("import com.acme.Helper;\npublic class Main { public static void main(String[] a) { System.out.println(new Helper()); } }");
		assert.equal(end(needsProject.events).compileError, true);
		assert.equal(looksLikeMissingProjectDependency(text(needsProject.events, "stderr")), true);

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

	// --- the browser surface -----------------------------------------------------
	if (process.argv.includes("--browser")) {
		assert.ok(jdk.available, "--browser needs a JDK: the Run control is disabled without one");
		// The switch must be on before the page loads, since status is fetched once.
		writeConfig({ enabled: true, timeoutMs: 30000 });
		const { chromium } = await import("playwright-core");
		const { CHROME_PATH } = await import("./lib/chrome.mjs");
		const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		try {
			const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
			await page.goto(`${base}/?token=${token}`);
			// Only present when the machine has no usable provider configured.
			if (await page.locator(".setup-modal .modal-close").count()) await page.locator(".setup-modal .modal-close").click();
			await page.locator(".inputbox textarea").waitFor({ timeout: 30000 });
			const composer = page.locator(".inputbox textarea");
			await composer.fill("show me a java example");
			await composer.press("Enter");

			const run = page.locator(".msg-text .playground-action").first();
			await run.waitFor({ timeout: 60000 });
			assert.equal(await run.isDisabled(), false, "the Run control must be usable when enabled with a JDK");
			assert.equal(await page.locator(".tool-call .playground-action").count(), 0, "tool-call cards must not gain a Run control");

			await run.click();
			const stdout = page.locator(".playground-stream pre").first();
			try {
				await stdout.waitFor({ timeout: 60000 });
			} catch {
				const area = await page.locator(".playground-result").first().innerText().catch(() => "(no result area)");
				throw new Error(`Run produced no stdout; result area was: ${area}`);
			}
			await page.waitForFunction(() => document.querySelector(".playground-stream pre")?.textContent?.includes("hello"));
			assert.match(await stdout.innerText(), /hello/);

			await page.getByRole("button", { name: "把结果发给 pi" }).first().click();
			await page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value.includes("hello"));
			assert.match(await composer.inputValue(), /```/, "send-to-pi inserts a fenced block, it does not send");
			assert.equal(modelCalls.length, 2, "send-to-pi must not trigger a model call");

			// --- the settings tab ---
			await page.getByRole("button", { name: "设置", exact: true }).first().click();
			await page.getByText("所有设置", { exact: true }).click();
			await page.getByRole("button", { name: "代码运行", exact: true }).click();
			await page.locator(".playground-warning").waitFor();
			assert.match(await page.locator(".playground-warning").innerText(), /不是沙箱/, "the panel must say it is not a sandbox");
			assert.match(await page.locator(".playground-jdk").innerText(), /JDK 27/, "the detected JDK is reported");

			// Turning it off needs no confirmation, and reaches the server.
			await page.locator(".playground-toggle input").click();
			await untilStatus(s => !s.enabled, "disabled");

			// Turning it back on does ask first.
			page.once("dialog", dialog => dialog.accept());
			await page.locator(".playground-toggle input").click();
			await untilStatus(s => s.enabled, "enabled");

			// The timeout commits on blur, not per keystroke, and is clamped by the server.
			await page.locator(".playground-field input").fill("5");
			await page.locator(".playground-field input").blur();
			await untilStatus(s => s.limits.timeoutMs === 5000, "a 5s timeout");
			await page.locator(".playground-field input").fill("999");
			await page.locator(".playground-field input").blur();
			await untilStatus(s => s.limits.timeoutMs === 60000, "a clamped timeout");
			// Re-detect must force a fresh probe, not just re-render the cached one.
			const forced = page.waitForRequest(request => request.url().includes("/api/playground/status?refresh=1"));
			await page.getByRole("button", { name: "重新检测", exact: true }).click();
			await forced;
			await page.keyboard.press("Escape");

			// --- the Notes entry ---
			const javaBlock = '```java\npublic class Main { public static void main(String[] a) { System.out.println("note hello"); } }\n```';
			const createNote = async (title, body) => (await (await fetch(`${base}/api/notes?token=${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, body, pinned: false }) })).json()).note;
			const note = await createNote("Playground note", javaBlock);
			await page.getByRole("button", { name: "小记", exact: true }).click();
			await page.locator(".note-list-item").first().click();
			const noteRun = page.locator("button[data-code-run]").first();
			await noteRun.waitFor({ timeout: 30000 });
			assert.equal(await noteRun.innerText(), "运行", "the Note control is labelled in the active locale");
			await noteRun.click();
			const noteOut = page.locator(".notes-editor > .playground-result .playground-stream pre").first();
			await noteOut.waitFor({ timeout: 60000 });
			assert.match(await noteOut.innerText(), /note hello/);

			// Running must not touch the note: not the body, not the version.
			const afterRun = (await (await fetch(`${base}/api/notes/${note.id}?token=${token}`)).json()).note;
			assert.equal(afterRun.body, javaBlock, "a Run must not write into the note body");
			assert.equal(afterRun.version, note.version, "a Run must not bump the note version");

			// Editing the code away marks the result stale rather than leaving it lying.
			await page.getByRole("button", { name: "Markdown 源码", exact: true }).click();
			await page.getByLabel("小记正文", { exact: true }).fill('```java\npublic class Main { }\n```');
			await page.locator(".playground-result .playground-badge.stale").waitFor({ timeout: 10000 });

			// Switching notes leaves no result behind.
			await createNote("Another note", "plain text");
			await page.getByRole("button", { name: "新建小记", exact: true }).first().click();
			await page.locator(".notes-editor > .playground-result").waitFor({ state: "detached", timeout: 10000 });
			await page.getByRole("button", { name: "对话", exact: true }).click();

			console.log("PASS playground browser: Notes run, no body write, stale after edit and cleared on switch");

			console.log("PASS playground browser: Run control on a reply, none on tool cards, streaming output, send-to-pi and the settings tab");
		} finally {
			await browser.close();
		}
	}

	// --- the environment switch --------------------------------------------------
	writeConfig({ enabled: true });
	await stop();
	await start({ PI_WEB_PLAYGROUND: "off" });
	const locked = await (await status()).json();
	assert.equal(locked.locked, true);
	assert.equal(locked.enabled, false, "the environment switch must override an enabled config file");
	assert.equal((await configure({ enabled: true })).status, 403, "a locked Playground must refuse to be enabled");
	assert.equal((await (await status()).json()).enabled, false);

	// The settings control must read as read-only rather than mysteriously off.
	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core");
		const { CHROME_PATH } = await import("./lib/chrome.mjs");
		const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		try {
			const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
			await page.goto(`${base}/?token=${token}`);
			if (await page.locator(".setup-modal .modal-close").count()) await page.locator(".setup-modal .modal-close").click();
			await page.getByRole("button", { name: "设置", exact: true }).first().click();
			await page.getByText("所有设置", { exact: true }).click();
			await page.getByRole("button", { name: "代码运行", exact: true }).click();
			assert.equal(await page.locator(".playground-toggle input").isDisabled(), true, "a locked switch is read-only");
			assert.match(await page.locator(".playground-hint").innerText(), /PI_WEB_PLAYGROUND/);
			console.log("PASS playground browser: the environment lock reads as read-only in settings");
		} finally {
			await browser.close();
		}
	}

	console.log("PASS playground API: auth, origin, default-off, limits, corrupt-config fail-closed, clamping and the environment lock");
} finally {
	await stop();
	model.closeAllConnections();
	await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
