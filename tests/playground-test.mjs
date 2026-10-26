import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { playgroundFixture, end, stdout } from "./lib/playground-fixture.mjs";
const fixture = await playgroundFixture();
const { api, run } = fixture;
try {
	const status = await (await api("status")).json();
	assert.equal(status.enabled, status.python.available);
	assert.deepEqual(status.limits, { timeoutMs: 10000, maxOutputBytes: 262144 });
	assert.equal((await fetch(`${fixture.base}/api/playground/status`)).status, 401);
	assert.equal((await api("config", {})).status, 400);
	assert.equal((await api("config", { maxHeapMb: 256 })).status, 400);
	assert.equal((await api("config", { timeoutMs: "bad" })).status, 400);
	assert.equal((await api("config", { enabled: true })).status, 200);
	assert.equal((await api("run", { code: "" })).status, 400);
	assert.equal((await api("run", { code: "x".repeat(262145) })).status, 400);
	assert.deepEqual(await (await api("scratch")).json(), { content: "", updatedAt: 0 });
	await api("scratch", { content: "print(1)" }, "PUT");
	assert.equal(JSON.parse(readFileSync(join(fixture.dataDir, "playground-scratch.json"))).content, "public class Legacy {}");
	if (!status.python.available) {
		assert.equal((await api("run", { code: "print(1)" })).status, 503);
		console.log("SKIP execution: host Python 3.9+ unavailable");
	} else {
		const events = await run('import sys\nprint("你好 🐍")\nprint("error output", file=sys.stderr)\nprint(repr(sys.stdin.read()))');
		assert.equal(end(events).exitCode, 0); assert.match(stdout(events), /你好 🐍/); assert.match(stdout(events), /''/);
		assert(events.some(e => e.stream === "stderr" && e.text.includes("error output")));
		assert(end(await run("def broken(:\n pass")).compileError);
		const error = end(await run("raise ValueError('broken')")); assert.equal(error.compileError, false); assert.equal(error.exitCode, 1);
		assert(end(await run("import missing_playground_package")).needsProject);
		await api("config", { timeoutMs: 1000 }); assert(end(await run("while True: pass")).timedOut);
		await api("config", { timeoutMs: 10000, maxOutputBytes: 1024 }); assert(end(await run('while True: print("x" * 1000)')).truncated);
		await api("config", { maxOutputBytes: 262144 });
		const controller = new AbortController();
		const response = await api("run", { code: "import os,time\nprint('PYTHON_PID=' + str(os.getpid()), flush=True)\ntime.sleep(30)" }, "POST", { signal: controller.signal });
		const reader = response.body.getReader();
		let received = "";
		while (!/PYTHON_PID=\d+/.test(received)) { const chunk = await reader.read(); assert(!chunk.done); received += new TextDecoder().decode(chunk.value); }
		const pythonPid = Number(/PYTHON_PID=(\d+)/.exec(received)[1]);
		assert.equal((await api("run", { code: "print(1)" })).status, 429);
		controller.abort();
		let available = false;
		for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 30)); const r = await api("run", { code: "print(2)" }); if (r.status === 200) { await r.text(); available = true; break; } assert.equal(r.status, 429); }
		assert(available, "disconnect releases execution slot");
		assert.throws(() => process.kill(pythonPid, 0), /ESRCH/, "cancel kills the actual Python process");
	}
	await api("config", { enabled: false }); assert.equal((await api("run", { code: "print(1)" })).status, 403);
	assert.equal((await api("scratch", { content: "print(2)" }, "PUT")).status, 200);
	console.log("PASS Python runtime: UTF-8 streams, stdin EOF, syntax/runtime/import failures, timeout, output budget, cancellation, concurrency, auth, config and preserved Java draft");
} finally { await fixture.stop(); }
const locked = await playgroundFixture({ PI_WEB_PLAYGROUND: "off" });
try { assert.equal((await (await locked.api("status")).json()).locked, true); assert.equal((await locked.api("config", { enabled: true })).status, 403); } finally { await locked.stop(); }
