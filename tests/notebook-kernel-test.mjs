import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { notebookKernels } from "../dist/server/notebook-kernel.js";
const dir = mkdtempSync(join(tmpdir(), "notebook-kernel-"));
const kernels = notebookKernels(dir);
const file = join(dir, "test.ipynb");
const request = (action, code, owner = "one", publish) =>
	kernels.request(owner, file, "notebook-" + action, code, publish);
try {
	await request("run", "answer = 42");
	assert.equal((await request("run", "answer")).outputs[0].data["text/plain"], "42");
	assert.equal((await request("run", "answer", "two")).outputs[0].ename, "NameError");
	let started;
	const active = new Promise((resolve) => {
		started = resolve;
	});
	const running = request("run", "import time\nprint('ready',flush=True)\ntime.sleep(30)", "one", () => started());
	await active;
	await request("interrupt");
	assert.equal((await running).outputs.at(-1).ename, "KeyboardInterrupt");
	assert.equal((await request("run", "answer")).outputs[0].data["text/plain"], "42");
	await request("close");
	assert.equal((await request("run", "answer")).outputs[0].ename, "NameError");
	let blockedReady, kernelPid = 0;
	const blockedActive = new Promise((resolve) => { blockedReady = resolve; });
	const blocked = request("run", "import os,signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nprint(f'kernel-pid={os.getpid()}',flush=True)\nwhile True: pass", "two", output => {
		const match = /kernel-pid=(\d+)/.exec(String(output.text ?? ""));
		if (match) { kernelPid = Number(match[1]); blockedReady(); }
	});
	const blockedResult = assert.rejects(blocked);
	await blockedActive;
	await Promise.all([request("close", undefined, "two"), request("close", undefined, "two")]);
	await blockedResult;
	assert(kernelPid > 0);
	for (let i = 0; i < 50; i++) {
		try { process.kill(kernelPid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); break; }
		await delay(50);
	}
	assert.throws(() => process.kill(kernelPid, 0), error => error.code === "ESRCH");
	writeFileSync(join(dir, "playground.json"), JSON.stringify({ enabled: false }));
	await assert.rejects(request("run", "42"), /disabled/);
	console.log("PASS independent kernels, interrupt, restart, bounded close and execution switch");
} finally {
	await kernels.close();
	rmSync(dir, { recursive: true, force: true });
}
