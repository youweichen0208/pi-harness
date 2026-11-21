import { createHash } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { realpathSync, lstatSync, unlinkSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { testEnv } from "./test-env.mjs";

export function parseSmokeArgs(args, defaults) {
	let timeoutMs = 180_000;
	const names = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
			const value = arg === "--timeout-ms" ? args[++i] : arg.slice(13);
			if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 2_147_483_647) throw new Error("--timeout-ms must be a positive integer ≤ 2147483647");
			timeoutMs = Number(value);
		} else if (arg.startsWith("-") || !/^[\w-]+$/.test(arg)) throw new Error(`Invalid test name or option: ${arg}`);
		else names.push(arg);
	}
	return { targets: names.length ? names : defaults, defaultSelection: names.length === 0, timeoutMs };
}

function inspectLock(address) {
	return new Promise(resolve => {
		const socket = createConnection(address);
		let text = "";
		socket.setTimeout(1000, () => { socket.destroy(); resolve({ active: true, text }); });
		socket.on("data", chunk => { text += chunk; });
		socket.on("end", () => resolve({ active: true, text }));
		socket.on("error", error => resolve({ active: !["ECONNREFUSED", "ENOENT"].includes(error.code), text }));
	});
}

/** The listening endpoint is the lock; no stale PID can authorize killing a process. */
export async function acquireSmokeLock(cwd) {
	const root = realpathSync(cwd);
	const hash = createHash("sha256").update(root).digest("hex").slice(0, 24);
	const address = process.platform === "win32" ? `\\\\.\\pipe\\pi-smoke-${hash}` : join("/tmp", `pi-smoke-${process.getuid?.() ?? "user"}-${hash}.sock`);
	const info = JSON.stringify({ pid: process.pid, cwd: root, startedAt: new Date().toISOString() });
	for (let attempt = 0; attempt < 3; attempt++) {
		const server = createServer(socket => { socket.on("error", () => {}); socket.end(info); });
		try {
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(address, () => { server.removeListener("error", reject); resolve(); });
			});
			return () => new Promise(resolve => server.close(resolve));
		} catch (error) {
			if (error.code !== "EADDRINUSE") throw error;
			let before;
			try { if (process.platform !== "win32") before = lstatSync(address); } catch {}
			const owner = await inspectLock(address);
			if (owner.active) throw new Error(`Smoke already running for this workspace: ${owner.text || root}`);
			// Unix sockets survive SIGKILL. Only unlink the same stale inode we inspected.
			if (before) {
				try { const after = lstatSync(address); if (before.ino === after.ino && before.dev === after.dev) unlinkSync(address); } catch (error) { if (error.code !== "ENOENT") throw error; }
			}
		}
	}
	throw new Error(`Unable to acquire smoke lock for ${root}; retry after the other runner exits`);
}

async function killTree(pid, exited = false) {
	if (!pid) return;
	if (process.platform === "win32") {
		await new Promise(resolve => {
			const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
			killer.once("error", resolve); killer.once("exit", resolve);
		});
	} else {
		try { process.kill(-pid, "SIGKILL"); } catch (error) {
			// Darwin may report EPERM for a group that is no longer signalable after
			// its leader exited. Never suppress permission failures for a live test.
			if (error.code !== "ESRCH" && !(exited && error.code === "EPERM")) throw error;
		}
	}
}

export async function runSmokeTest({ file, cwd, timeoutMs, signal, label, log = console.log, heartbeatMs = 15_000 }) {
	const start = Date.now();
	const isolated = mkdtempSync(join(tmpdir(), "pi-smoke-"));
	const agentDir = join(isolated, "agent"), dataDir = join(isolated, "data");
	mkdirSync(agentDir); mkdirSync(dataDir);
	let child, timer, heartbeat, stopping;
	let status;
	const stop = reason => {
		if (stopping) return stopping;
		status = reason;
		stopping = killTree(child?.pid);
		return stopping;
	};
	const abort = () => { void stop("interrupted"); };
	try {
		if (signal?.aborted) return { status: "interrupted", durationMs: 0 };
		child = spawn(process.execPath, [file], {
			cwd, stdio: "inherit", detached: process.platform !== "win32",
			env: { ...testEnv(), PI_CODING_AGENT_DIR: agentDir, PI_WEB_DATA_DIR: dataDir },
		});
		const exited = new Promise(resolve => {
			child.once("error", error => { log(`${label} launch failed: ${error.message}`); resolve(null); });
			child.once("exit", resolve);
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		timer = setTimeout(() => { log(`${label} TIMEOUT after ${timeoutMs}ms`); void stop("timeout"); }, timeoutMs);
		heartbeat = setInterval(() => log(`${label} running · ${((Date.now() - start) / 1000).toFixed(1)}s`), heartbeatMs);
		const code = await exited;
		await stopping;
		return { status: status ?? (code === 0 ? "passed" : "failed"), durationMs: Date.now() - start };
	} finally {
		clearTimeout(timer); clearInterval(heartbeat);
		signal?.removeEventListener("abort", abort);
		// Clean up descendants left behind even when the test parent exited normally.
		if (stopping) await stopping;
		else if (child?.pid && process.platform !== "win32") await killTree(child.pid, true);
		rmSync(isolated, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}
