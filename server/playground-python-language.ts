/** Bounded stateless Python analysis. Never executes the submitted source. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { killPidTree } from "./process-utils.js";
import { PYTHON_ANALYSIS } from "./playground-python-scripts.js";
import type { PythonCommand } from "./playground-python.js";
import type { PythonLanguageResult, PlaygroundFormatResult } from "./protocol.js";
export async function analyzePython(python: PythonCommand, code: string, offset: number, action: string, signal: AbortSignal, toolsPath?: string): Promise<PythonLanguageResult & Partial<PlaygroundFormatResult>> {
	const directory = mkdtempSync(join(tmpdir(), "pi-python-analysis-"));
	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(python.command, [...python.args, "-I", "-X", "utf8", "-u", "-c", PYTHON_ANALYSIS], { cwd: directory, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
			let out = "", error = "", bytes = 0, stopped = false;
			const stop = () => { stopped = true; if (child.pid) killPidTree(child.pid); };
			const timer = setTimeout(stop, 20000);
			signal.addEventListener("abort", stop, { once: true });
			if (signal.aborted) stop();
			const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
			child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) stop(); else out += chunk; });
			child.stderr.on("data", (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) stop(); else error = (error + chunk).slice(-4000); });
			child.stdin.on("error", () => {});
			child.on("error", e => { cleanup(); reject(e); });
			child.on("exit", () => { if (child.pid && process.platform !== "win32") killPidTree(child.pid); });
			child.on("close", status => {
				cleanup();
				if (stopped || status !== 0) { reject(new Error(stopped ? "Python analysis cancelled, timed out or exceeded output limit" : error.includes("No module named") ? `Install ${action === "format" ? "black" : "jedi"} in the selected Python environment.` : error || "Python analysis failed")); return; }
				try { resolve(JSON.parse(out)); } catch { reject(new Error("Invalid Python analysis result")); }
			});
			child.stdin.end(JSON.stringify({ code, offset, action, toolsPath }));
		});
	} finally { rmSync(directory, { recursive: true, force: true }); }
}
