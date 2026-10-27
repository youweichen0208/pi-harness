/** User-triggered editor dependencies, isolated from the host's site-packages. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { killPidTree } from "./process-utils.js";
import { writeFileAtomic } from "./private-file.js";
import type { PythonCommand } from "./playground-python.js";

export class PythonTools {
	private installing = false;
	constructor(private readonly dataDir: string) {}
	private root(python: PythonCommand): string {
		return join(this.dataDir, "python-tools", createHash("sha256").update(JSON.stringify(python)).digest("hex").slice(0, 24));
	}
	path(python: PythonCommand): string | undefined {
		try {
			const name = readFileSync(join(this.root(python), "current"), "utf8");
			if (/^[a-f0-9-]{36}$/.test(name)) return join(this.root(python), name);
		} catch { /* No application-managed tools yet. */ }
		return undefined;
	}
	async install(python: PythonCommand, signal: AbortSignal): Promise<void> {
		if (this.installing) throw new Error("Python tools installation is already running. Retry shortly.");
		this.installing = true;
		const name = randomUUID(), root = this.root(python), target = join(root, name);
		let committed = false;
		try {
			mkdirSync(target, { recursive: true });
			await command(python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-warn-script-location", "--target", target, "jedi", "black"], signal);
			await command(python, ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import jedi, black", target], signal);
			if (signal.aborted) throw new Error("Python tools installation cancelled");
			// Keep previous generations available to analyses that are already running.
			writeFileAtomic(join(root, "current"), name);
			committed = true;
		} finally {
			if (!committed) rmSync(target, { recursive: true, force: true });
			this.installing = false;
		}
	}
}

function command(python: PythonCommand, args: string[], signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(new Error("Python tools installation cancelled")); return; }
		const child = spawn(python.command, [...python.args, "-I", "-X", "utf8", "-u", ...args], { detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", bytes = 0, stopped = "";
		const stop = (reason: string) => { stopped = reason; if (child.pid) killPidTree(child.pid); };
		const abort = () => stop("Python tools installation cancelled");
		const timer = setTimeout(() => stop("Python tools installation timed out (180s)"), 180000);
		signal.addEventListener("abort", abort, { once: true });
		const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				bytes += Buffer.byteLength(chunk); output = (output + chunk).slice(-6000);
				if (bytes > 1024 * 1024) stop("Python tools installation exceeded output limit");
			});
		}
		child.once("error", error => { cleanup(); reject(error); });
		child.once("exit", () => { if (child.pid && process.platform !== "win32") killPidTree(child.pid); });
		child.once("close", code => {
			cleanup();
			if (stopped || code !== 0) reject(new Error(stopped || output || "Python tools installation failed"));
			else resolve();
		});
	});
}
