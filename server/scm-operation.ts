import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { killPidTree } from "./process-utils.js";

const active = new Set<string>();
function run(cwd: string, args: string[]): Promise<string> {
	return new Promise((done, reject) => {
		const child = spawn("git", args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: {
			...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_EDITOR: "false", GIT_SEQUENCE_EDITOR: "false", GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
		} });
		let output = "", bytes = 0, failure = "";
		const stop = (reason: string) => { if (failure) return; failure = reason; if (child.pid) killPidTree(child.pid); };
		const timer = setTimeout(() => stop("Git operation timed out; check repository state before retrying."), 120_000);
		const collect = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) stop("Git output exceeded 1 MiB; check repository state."); else output += chunk.toString("utf8"); };
		child.stdout.on("data", collect); child.stderr.on("data", collect);
		child.on("error", error => { clearTimeout(timer); reject(error); });
		child.on("close", code => { clearTimeout(timer); if (failure || code !== 0) reject(new Error([failure, output.trim() || `Git exited with code ${code}`].filter(Boolean).join("\n"))); else done(output.trim()); });
	});
}

/** Fixed operations only. Never replay a failed write or invoke a shell. */
export async function scmOperation(cwd: string, action: string, branch: unknown, admit: () => boolean = () => true): Promise<string> {
	if (!["switch", "push", "pull"].includes(action)) throw Error("Invalid Git operation");
	if (action === "switch" && (typeof branch !== "string" || !branch || branch.startsWith("-") || /[\x00-\x20\x7f]/.test(branch))) throw Error("Invalid branch");
	const common = await run(cwd, ["rev-parse", "--git-common-dir"]);
	const key = await realpath(resolve(cwd, common));
	if (!admit()) throw Error("Workspace unavailable");
	if (active.has(key)) throw Error("Another Git operation is running for this repository");
	active.add(key);
	try {
		let args = [action];
		if (action === "switch") {
			const refs = (await run(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])).split("\n");
			if (refs.includes(`refs/heads/${branch}`)) args = ["switch", "--", branch as string];
			else if (refs.includes(`refs/remotes/${branch}`) && !(branch as string).endsWith("/HEAD")) args = ["switch", "--track", "--", branch as string];
			else throw Error("Branch no longer exists; refresh the branch list");
		}
		if (!admit()) throw Error("Workspace unavailable");
		return await run(cwd, args);
	} finally { active.delete(key); }
}
