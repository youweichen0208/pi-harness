import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export async function runWorker(operation, input, { signal, timeoutMs = 30000 } = {}) {
	signal?.throwIfAborted();
	const started = performance.now();
	const directory = await realpath(await mkdtemp(join(tmpdir(), "omp-context-eval-")));
	let child, closed, timer, killTimer;
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("PI_") || key.startsWith("OMP_") || key === "ELECTRON_RUN_AS_NODE") delete env[key];
	env.PI_CODING_AGENT_DIR = join(directory, "agent");
	env.CONTEXT_EVAL_DIRECTORY = directory;
	env.PI_NOTIFICATIONS = "off";
	let cancelled;
	const abort = reason => {
		if (cancelled) return;
		cancelled = reason instanceof Error ? reason : new Error("Evaluation cancelled");
		child?.stdin.write(`${JSON.stringify({ abort: true })}\n`);
		killTimer = setTimeout(() => {
			if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
			if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
			else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
		}, 3000);
	};
	const onAbort = () => abort(signal?.reason);
	try {
		await mkdir(env.PI_CODING_AGENT_DIR);
		const executable = join(dirname(require.resolve("bun/package.json")), "bin", "bun.exe");
		child = spawn(executable, [fileURLToPath(new URL("./worker.mjs", import.meta.url))], {
			cwd: directory, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32",
		});
		child.stdin.on("error", () => {});
		const chunks = [];
		let outputBytes = 0;
		child.stdout.on("data", chunk => {
			if (outputBytes > 16 * 1024 * 1024) return;
			outputBytes += chunk.length;
			if (outputBytes > 16 * 1024 * 1024) abort(new Error("Evaluation result exceeds 16 MiB"));
			else chunks.push(chunk);
		});
		closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
		child.stdin.write(`${JSON.stringify({ operation, ...input })}\n`);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		timer = setTimeout(() => abort(new Error("Evaluation question timed out")), timeoutMs);
		const code = await closed;
		let response;
		try { response = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw cancelled ?? new Error(`OMP evaluation worker exited without a result (${code})`); }
		if (operation === "session" && response.result) response.result.durationMs = Math.round(performance.now() - started);
		if (cancelled || response.error || code !== 0) throw Object.assign(cancelled ?? new Error(response.error ?? "OMP evaluation failed"), { result: response.result });
		return response.result;
	} finally {
		if (child?.pid && child.exitCode === null && child.signalCode === null) {
			abort(new Error("Evaluation coordinator stopped"));
			await closed?.catch(() => {});
		}
		clearTimeout(timer); clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
		await rm(directory, { recursive: true, force: true });
	}
}
