/** Bind test listeners directly; never release a probe and assume the port stays free. */
import { randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { testEnv } from "./test-env.mjs";

const nextTestPort = () => randomInt(20000, 60000);
function checkedPort(port) {
	if (!Number.isInteger(port) || port < 8900 || port > 65535) throw Error("Test ports must be integers from 8900 to 65535");
	return port;
}

/** A fixture model keeps the actual bound socket throughout the test. */
export async function listenIsolated(server, { nextPort = nextTestPort, attempts = 8 } = {}) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const port = checkedPort(nextPort());
		try {
			await new Promise((resolve, reject) => {
				const failed = error => { server.off("listening", ready); reject(error); };
				const ready = () => { server.off("error", failed); resolve(); };
				server.once("error", failed); server.once("listening", ready);
				server.listen(port, "127.0.0.1");
			});
			return port;
		} catch (error) {
			if (error.code !== "EADDRINUSE") throw error;
		}
	}
	throw Error(`No isolated test port available after ${attempts} bind attempts`);
}

/** Start the real harness on a high port. Only bind collisions are retried;
 * other startup failures remain failures. Ready requires this child's bind log
 * and PID, so an unrelated HTTP server is never mistaken for the fixture. */
export async function startIsolatedHarness({ env = {}, nextPort = nextTestPort, attempts = 8, timeoutMs = 20000, onOutput = () => {}, args = ["dist/server/index.js"] } = {}) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const port = checkedPort(nextPort());
		const child = spawn(process.execPath, args, { env: testEnv({ ...env, PORT: String(port), PI_WEB_HOST: "127.0.0.1" }), stdio: ["ignore", "pipe", "pipe"] });
		let logs = "", closed = false, spawnError;
		const output = chunk => { logs = (logs + chunk).slice(-16000); onOutput(String(chunk)); };
		child.stdout.on("data", output); child.stderr.on("data", output);
		child.once("error", error => { spawnError = error; });
		const completion = new Promise(resolve => child.once("close", () => { closed = true; resolve(); }));
		const stop = async () => {
			if (closed) return;
			if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
			const force = setTimeout(() => { if (!closed && child.pid) child.kill("SIGKILL"); }, 2000);
			try { await completion; } finally { clearTimeout(force); }
		};
		try {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (spawnError) throw spawnError;
				if (closed) {
					if (/\bEADDRINUSE\b/.test(logs)) break;
					throw Error(`Test server exited (${child.exitCode ?? child.signalCode}):\n${logs}`);
				}
				if (logs.includes(`http://localhost:${port}`)) {
					try {
						const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
						if (response.ok && (await response.json()).pid === child.pid && child.exitCode === null && child.signalCode === null) {
							return { child, port, stop, get logs() { return logs; } };
						}
						throw Error("Test server health belongs to a different process");
					} catch (error) {
						if (error.message === "Test server health belongs to a different process") throw error;
					}
				}
				await sleep(25);
			}
			if (!closed || !/\bEADDRINUSE\b/.test(logs)) throw Error(`Test server readiness timed out:\n${logs}`);
		} catch (error) {
			await stop(); throw error;
		}
		await stop();
	}
	throw Error(`No isolated harness port available after ${attempts} bind attempts`);
}
