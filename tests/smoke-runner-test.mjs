import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireSmokeLock, parseSmokeArgs, runSmokeTest } from "./lib/smoke-runner.mjs";
import { testEnv } from "./lib/test-env.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(fn) {
	const cwd = mkdtempSync(join(tmpdir(), "smoke-runner-test-"));
	try { await fn(cwd, (name, code) => { const file = join(cwd, `${name}.mjs`); writeFileSync(file, code); return file; }); }
	finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("arguments preserve named selection and validate timeout", () => {
	assert.deepEqual(parseSmokeArgs(["--timeout-ms", "500", "one"], ["default"]), { targets: ["one"], timeoutMs: 500, defaultSelection: false });
	assert.equal(parseSmokeArgs(["--timeout-ms=42"], ["one"]).timeoutMs, 42);
	for (const args of [["--timeout-ms"], ["--timeout-ms=0"], ["--timeout-ms=NaN"], ["--timeout-ms=2147483648"], ["../escape"], ["--unknown"]]) assert.throws(() => parseSmokeArgs(args, []));
});

test("workspace lock rejects duplicates and releases for a later run", async () => fixture(async cwd => {
	const release = await acquireSmokeLock(cwd);
	try {
		await assert.rejects(acquireSmokeLock(realpathSync(cwd)), /already running.*pid/);
		await fixture(async other => { const unlock = await acquireSmokeLock(other); await unlock(); });
	} finally { await release(); }
	const again = await acquireSmokeLock(cwd); await again();
}));

test("success, failure and launch errors return independent outcomes and clean data dirs", async () => fixture(async (cwd, write) => {
	const record = join(cwd, "data-path");
	const file = write("pass", `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(record)}, process.env.PI_WEB_DATA_DIR);`);
	assert.equal((await runSmokeTest({ file, cwd, timeoutMs: 2000, label: "pass" })).status, "passed");
	assert.equal(existsSync(readFileSync(record, "utf8")), false);
	assert.equal((await runSmokeTest({ file: write("fail", "process.exit(7)"), cwd, timeoutMs: 2000, label: "fail" })).status, "failed");
	assert.equal((await runSmokeTest({ file, cwd: join(cwd, "missing-directory"), timeoutMs: 2000, label: "launch-error", log: () => {} })).status, "failed");
}));

test("timeout emits progress and kills the owned child tree without killing a bystander", async () => fixture(async (cwd, write) => {
	const record = join(cwd, "child-pid");
	const file = write("hang", `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); writeFileSync(${JSON.stringify(record)}, String(child.pid)); setInterval(()=>{},1000);`);
	const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", env: testEnv() });
	const lines = [];
	try {
		const result = await runSmokeTest({ file, cwd, timeoutMs: 700, label: "[1/1] hang", heartbeatMs: 100, log: line => lines.push(line) });
		assert.equal(result.status, "timeout");
		assert(lines.some(line => line.includes("running")));
		assert(lines.some(line => line.includes("TIMEOUT")));
		process.kill(bystander.pid, 0);
		const pid = Number(readFileSync(record, "utf8"));
		let alive = true;
		for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await pause(20); } catch { alive = false; break; } }
		assert.equal(alive, false, "owned grandchild must exit");
	} finally { const closed = new Promise(resolve => bystander.once("exit", resolve)); bystander.kill(); await closed; }
}));

test("abort cleans current test and leaves the next run usable", async () => fixture(async (cwd, write) => {
	const controller = new AbortController();
	const file = write("abort", "setInterval(()=>{},1000)");
	const timer = setTimeout(() => controller.abort(), 200);
	try { assert.equal((await runSmokeTest({ file, cwd, timeoutMs: 2000, signal: controller.signal, label: "abort" })).status, "interrupted"); }
	finally { clearTimeout(timer); }
	assert.equal((await runSmokeTest({ file: write("after", ""), cwd, timeoutMs: 2000, label: "after" })).status, "passed");
}));

test("crashed lock owner can be replaced without a stale lock blocking future runs", async () => fixture(async (cwd, write) => {
	const moduleUrl = new URL("./lib/smoke-runner.mjs", import.meta.url).href;
	const file = write("owner", `import { acquireSmokeLock } from ${JSON.stringify(moduleUrl)}; await acquireSmokeLock(${JSON.stringify(cwd)}); console.log('locked');`);
	const owner = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "inherit"], env: testEnv() });
	try {
		await new Promise((resolve, reject) => { owner.stdout.once("data", resolve); owner.once("error", reject); owner.once("exit", code => reject(new Error(`owner exited early: ${code}`))); });
		await assert.rejects(acquireSmokeLock(cwd), /already running/);
		const exited = new Promise(resolve => owner.once("exit", resolve));
		owner.kill("SIGKILL"); await exited;
		const release = await acquireSmokeLock(cwd); await release();
	} finally { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); }
}));

test("SIGTERM stops the CLI queue, returns 143 and releases its workspace lock", { skip: process.platform === "win32" }, async () => fixture(async (cwd, write) => {
	const tests = join(cwd, "tests"); mkdirSync(join(tests, "lib"), { recursive: true });
	for (const name of ["run-smoke.mjs", "lib/smoke-runner.mjs", "lib/test-env.mjs"]) copyFileSync(new URL(name, import.meta.url), join(tests, name));
	writeFileSync(join(tests, "hang.mjs"), "console.log('fixture-started'); setInterval(()=>{},1000);");
	writeFileSync(join(tests, "after.mjs"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(cwd, "should-not-run"))}, 'bad');`);
	const runner = spawn(process.execPath, [join(tests, "run-smoke.mjs"), "hang", "after"], { stdio: ["ignore", "pipe", "pipe"], env: testEnv() });
	let output = "";
	const exited = new Promise(resolve => runner.once("exit", resolve));
	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`runner did not start: ${output}`)), 5000);
			runner.stdout.on("data", chunk => { output += chunk; if (output.includes("fixture-started")) { clearTimeout(timer); resolve(); } });
			runner.once("error", error => { clearTimeout(timer); reject(error); });
		});
		runner.kill("SIGTERM");
		assert.equal(await exited, 143);
		assert.match(output, /interrupted/);
		assert.equal(existsSync(join(cwd, "should-not-run")), false);
		const release = await acquireSmokeLock(cwd); await release();
	} finally { if (runner.exitCode === null && runner.signalCode === null) { runner.kill("SIGTERM"); await exited; } }
}));
