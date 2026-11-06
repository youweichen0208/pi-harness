import spawn from "cross-spawn";
import { delimiter, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { killPidTree } from "./process-utils.js";
import type { PiCliStatus, CliToolStatus } from "./protocol.js";

/** npm injects dependency .bin directories; these are not a user's Pi CLI. */
export function cliProbeEnv(env = process.env): NodeJS.ProcessEnv {
	const key = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
	const paths = (env[key] ?? "").split(delimiter).filter(path => isAbsolute(path) && !/[/\\]node_modules[/\\]\.bin[/\\]?$/i.test(path));
	return { ...env, [key]: paths.join(delimiter) };
}

export function probeCliTool(command: string, env: NodeJS.ProcessEnv, timeout = 5000): Promise<CliToolStatus> {
	return new Promise(resolve => {
		const child = spawn(command, ["--version"], { cwd: homedir(), env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		let output = "", bytes = 0, finished = false;
		const finish = (result: CliToolStatus) => {
			if (finished) return;
			finished = true; clearTimeout(timer);
			child.stdout?.destroy(); child.stderr?.destroy();
			resolve(result);
		};
		const stop = (reason: string) => {
			if (child.pid) killPidTree(child.pid);
			child.kill("SIGKILL");
			finish({ status: "unusable", reason });
		};
		const timer = setTimeout(() => stop("timeout"), timeout);
		const collect = (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 16384) { stop("output-limit"); return; }
			output += chunk.toString();
		};
		child.stdout?.on("data", collect); child.stderr?.on("data", collect);
		child.once("error", (error: NodeJS.ErrnoException) => finish({ status: error.code === "ENOENT" ? "missing" : "unusable", reason: error.code ?? "spawn" }));
		child.once("close", code => {
			const version = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?=\s|$)/.exec(output.trim())?.[1];
			finish(code === 0 && version ? { status: "available", version } : { status: "unusable", reason: "version" });
		});
	});
}

export async function piCliStatus(env = process.env): Promise<PiCliStatus> {
	const clean = cliProbeEnv(env);
	const [pi, node, npm] = await Promise.all(["pi", "node", "npm"].map(tool => probeCliTool(tool, clean)));
	const [major, minor] = (node.version ?? "0.0.0").split(".").map(Number);
	return { pi, node, npm, canInstall: pi.status === "missing" && node.status === "available" && (major > 22 || major === 22 && minor >= 19) && npm.status === "available" };
}
