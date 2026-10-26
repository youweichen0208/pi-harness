/** Host Python 3 discovery. No runtime installation or shell command evaluation. */
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { PlaygroundPythonStatus } from "./protocol.js";
export interface PythonCommand { command: string; args: string[] }
export type PythonEnv = Readonly<Record<string, string | undefined>>;
export function pythonCandidates(env: PythonEnv, platform = process.platform): PythonCommand[] {
	if (env.PI_WEB_PYTHON?.trim()) return [{ command: env.PI_WEB_PYTHON.trim(), args: [] }];
	return [
		...(env.VIRTUAL_ENV ? [{ command: join(env.VIRTUAL_ENV, platform === "win32" ? "Scripts/python.exe" : "bin/python"), args: [] }] : []),
		{ command: "python3", args: [] }, { command: "python", args: [] },
		...(platform === "win32" ? [{ command: "py", args: ["-3"] }] : []),
	];
}
export async function probePython(env: PythonEnv = process.env): Promise<PlaygroundPythonStatus> {
	let reason = "Python 3.9+ was not found. Install Python or set PI_WEB_PYTHON to its executable.";
	for (const candidate of pythonCandidates(env)) {
		const result = await new Promise<PlaygroundPythonStatus | undefined>(resolve => {
			execFile(candidate.command, [...candidate.args, "-I", "-X", "utf8", "-c", "import sys,json; print(json.dumps([list(sys.version_info[:3]),sys.executable]))"], { env: { ...env }, timeout: 5000, maxBuffer: 16384, windowsHide: true }, (error, stdout) => {
				if (error) { reason = error.message.slice(0, 500); resolve(undefined); return; }
				try {
					const [version, path] = JSON.parse(stdout) as [number[], string];
					if (version[0] !== 3 || version[1] < 9) { reason = "Python 3.9 or newer is required"; resolve(undefined); return; }
					resolve({ available: true, version: version.join("."), path, command: path, args: [] });
				} catch { resolve(undefined); }
			});
		});
		if (result) return result;
	}
	return { available: false, reason };
}
export class PythonProbe {
	private cached?: { at: number; status: PlaygroundPythonStatus };
	constructor(private readonly probe: () => Promise<PlaygroundPythonStatus>, private readonly ttlMs = 60000, private readonly now = Date.now) {}
	async get(force = false): Promise<PlaygroundPythonStatus> {
		if (!force && this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.status;
		const status = await this.probe(); this.cached = { at: this.now(), status }; return status;
	}
}
export const createPythonProbe = (env: PythonEnv = process.env) => new PythonProbe(() => probePython(env));
