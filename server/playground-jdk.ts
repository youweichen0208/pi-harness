/**
 * Locating a JDK on the host machine.
 *
 * The Playground never bundles a JVM: the Docker image and the Electron package
 * both ship without one, and a host that has no JDK simply gets a disabled
 * feature with a reason. Resolution is therefore a first-class concern, and a
 * failed probe must never be able to take the server down.
 *
 * `resolveJdkCommands` is pure (the filesystem is injected) so the interesting
 * rule — a JDK needs BOTH `javac` and `java`, a JRE has only the latter — is
 * unit-testable without installing anything.
 */

import { accessSync, constants } from "node:fs";
import { posix, win32 } from "node:path";
import { execFile } from "node:child_process";

export interface JdkCommands {
	javac: string;
	java: string;
}

export interface JdkStatus {
	available: boolean;
	version?: string;
	path?: string;
	/** Why the JDK is unusable; shown in the UI so the user can fix it. */
	reason?: string;
}

/**
 * The first directory holding both `javac` and `java`. `JAVA_HOME/bin` wins over
 * PATH, so a user can point the Playground at a specific JDK without changing
 * their shell. Requiring both in the same directory is what rejects a JRE-only
 * install: it has `java` but no compiler.
 */
export function resolveJdkCommands(
	env: Readonly<{ JAVA_HOME?: string; PATH?: string }>,
	exists: (path: string) => boolean,
	platform: NodeJS.Platform = process.platform,
): JdkCommands | undefined {
	const path = platform === "win32" ? win32 : posix;
	const suffix = platform === "win32" ? ".exe" : "";
	const separator = platform === "win32" ? ";" : ":";

	const directories: string[] = [];
	const home = env.JAVA_HOME?.trim();
	if (home) directories.push(path.join(home, "bin"));
	for (const entry of (env.PATH ?? "").split(separator)) {
		const directory = entry.trim();
		if (directory) directories.push(directory);
	}

	for (const directory of directories) {
		const javac = path.join(directory, `javac${suffix}`);
		const java = path.join(directory, `java${suffix}`);
		if (exists(javac) && exists(java)) return { javac, java };
	}
	return undefined;
}

function exists(path: string): boolean {
	try {
		accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** First non-empty line, trimmed and capped — the UI shows this verbatim. */
function firstLine(text: string): string | undefined {
	const line = text.split(/\r?\n/).map(part => part.trim()).find(Boolean);
	return line?.slice(0, 200);
}

/** `javac -version` prints to stderr on some JDKs and stdout on others. */
function runVersion(command: string): Promise<{ version?: string; error?: string }> {
	return new Promise(resolve => {
		execFile(command, ["-version"], { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
			const text = `${stdout}${stderr}`;
			const version = /javac\s+(\S+)/.exec(text)?.[1];
			if (version) {
				resolve({ version });
				return;
			}
			// macOS ships /usr/bin/javac stubs that exist but refuse to run; their
			// stderr ("Unable to locate a Java Runtime") is the useful explanation.
			resolve({ error: firstLine(text) ?? (error ? error.message : undefined) });
		});
	});
}

export interface JdkProbeDeps {
	resolve?: (env: Readonly<{ JAVA_HOME?: string; PATH?: string }>) => JdkCommands | undefined;
	runVersion?: (command: string) => Promise<{ version?: string; error?: string }>;
}

/** Ask the machine whether it has a usable JDK. Never throws. */
export async function probeJdk(
	env: Readonly<{ JAVA_HOME?: string; PATH?: string }>,
	deps: JdkProbeDeps = {},
): Promise<JdkStatus> {
	const resolve = deps.resolve ?? ((value: Readonly<{ JAVA_HOME?: string; PATH?: string }>) => resolveJdkCommands(value, exists));
	const version = deps.runVersion ?? runVersion;
	const commands = resolve(env);
	if (!commands) {
		return {
			available: false,
			reason: env.JAVA_HOME?.trim()
				? "No JDK found: javac and java are required (JAVA_HOME and PATH were checked)"
				: "No JDK found: javac and java are required (PATH was checked)",
		};
	}
	const result = await version(commands.javac);
	return result.version
		? { available: true, version: result.version, path: commands.javac }
		: { available: false, path: commands.javac, reason: `No usable JDK found: ${result.error ?? "javac could not be executed"}` };
}

/**
 * Lazily probes for a JDK and caches the answer briefly. Lazy because users
 * routinely install a JDK while the server is already running; a TTL plus the
 * explicit re-detect action keeps that from needing a restart.
 */
export class JdkProbe {
	private cached?: { at: number; status: JdkStatus };

	constructor(
		private readonly probe: () => Promise<JdkStatus>,
		private readonly ttlMs = 60_000,
		private readonly now: () => number = Date.now,
	) {}

	async get(force = false): Promise<JdkStatus> {
		if (!force && this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.status;
		const status = await this.probe();
		this.cached = { at: this.now(), status };
		return status;
	}
}

/** The probe wired to the real machine. */
export function createJdkProbe(
	env: Readonly<{ JAVA_HOME?: string; PATH?: string }> = process.env,
	ttlMs = 60_000,
): JdkProbe {
	return new JdkProbe(() => probeJdk(env), ttlMs);
}
