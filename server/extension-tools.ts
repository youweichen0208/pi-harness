import spawn from "cross-spawn";
import { killPidTree } from "./process-utils.js";

/** Probe only when an operation needs the tool. Respect native npmCommand arguments. */
export async function requireExtensionCommand(command: string[], cwd: string, env = process.env): Promise<void> {
	const [executable, ...args] = command;
	if (!executable) throw Error("Invalid npmCommand: expected a non-empty executable");
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, [...args, "--version"], { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		let output = "", limit = "", settled = false;
		let outputBytes = 0;
		const report = (active: boolean) => { if (process.connected && child.pid) process.send?.({ extensionToolPid: child.pid, active }, () => {}); };
		report(true);
		const stop = () => { if (child.pid) killPidTree(child.pid); child.kill("SIGKILL"); };
		const timer = setTimeout(() => { limit = "Tool probe timed out"; stop(); finish(); }, 5000);
		const finish = (error?: NodeJS.ErrnoException, code?: number | null) => {
			if (settled) return;
			settled = true; clearTimeout(timer); report(false);
			child.stdout?.destroy(); child.stderr?.destroy();
			if (!error && !limit && code === 0) { resolve(); return; }
			const reason = limit || error?.message || `Command exited with code ${code}: ${output.trim()}`;
			const diagnosed = extensionToolFailure(Error(reason), output);
			if (diagnosed.message.startsWith("[extension-tool-")) { reject(diagnosed); return; }
			reject(Error(`[extension-tool-${error?.code === "ENOENT" ? "missing" : "unusable"}:${encodeURIComponent(executable)}] ${reason}`));
		};
		const collect = (chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			output = (output + chunk.toString()).slice(-16384);
			if (outputBytes > 16384) { limit = "Tool probe exceeded output limit"; stop(); finish(); }
		};
		child.stdout?.on("data", collect); child.stderr?.on("data", collect);
		child.once("error", error => finish(error));
		child.once("close", code => finish(undefined, code));
	});
}

/** Only annotate explicit missing-command diagnostics; ordinary package failures stay intact. */
export function extensionToolFailure(error: Error, output: string): Error {
	if (error.message.startsWith("[extension-tool-")) return error;
	const text = `${error.message}\n${output}`;
	for (const tool of ["node", "npm", "git"]) {
		const missing = new RegExp(`(?:spawn ${tool} ENOENT|(?:^|[\\s:'"/])${tool}(?:\\.exe)?['"]?: (?:command )?not found|env: ${tool}: No such file|['"]${tool}['"] is not recognized)`, "im");
		if (missing.test(text)) return Error(`[extension-tool-missing:${tool}] ${error.message}\n${output.slice(-4000)}`);
	}
	return error;
}
