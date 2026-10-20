/**
 * Running one Java source on the host JDK.
 *
 * A Run is a bare child process, not a sandbox: it has the server user's
 * permissions, it can reach the network, and it is documented as such. What
 * this module does provide is containment of the *accident* — a fresh temp
 * directory per Run, a wall-clock deadline, an output cap that kills rather
 * than truncates, and a process-tree kill on every exit path, so a runaway
 * program cannot outlive its Run or fill the disk.
 *
 * The workspace is never mounted and never used as a classpath: a Run compiles
 * one self-contained file against nothing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PlaygroundEvent, PlaygroundLimits } from "./protocol.js";
import { killPidTree } from "./process-utils.js";
import { OutputBudget, introspectJavaSource } from "./playground-source.js";
import type { JdkCommands } from "./playground-jdk.js";

/**
 * Admission control for Runs. Limits are passed per call rather than captured,
 * so a settings change takes effect without recreating the gate.
 */
export class ConcurrencyGate {
	private active = 0;
	private readonly perKey = new Map<string, number>();

	get running(): number {
		return this.active;
	}

	/** A release function, or undefined when the caller must be refused. */
	acquire(key: string | undefined, maxGlobal: number, maxPerKey: number): (() => void) | undefined {
		if (this.active >= maxGlobal) return undefined;
		if (key && (this.perKey.get(key) ?? 0) >= maxPerKey) return undefined;
		this.active += 1;
		if (key) this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active -= 1;
			if (!key) return;
			const remaining = (this.perKey.get(key) ?? 1) - 1;
			if (remaining > 0) this.perKey.set(key, remaining);
			else this.perKey.delete(key);
		};
	}
}

export interface RunJavaOptions {
	code: string;
	limits: PlaygroundLimits;
	jdk: JdkCommands;
	onEvent: (event: PlaygroundEvent) => void;
	/** Aborted when the client goes away; kills the process tree. */
	signal: AbortSignal;
}

export interface RunSummary {
	runId: string;
	durationMs: number;
	exitCode: number | null;
	compileError: boolean;
	timedOut: boolean;
	truncated: boolean;
	aborted: boolean;
}

function spawnPhase(
	command: string,
	args: string[],
	options: {
		cwd: string;
		forward: (stream: "stdout" | "stderr", chunk: string) => void;
		shouldStop: () => boolean;
		register: (child: ChildProcess) => void;
	},
): Promise<number | null> {
	return new Promise(resolve => {
		let child: ChildProcess;
		try {
			// `detached` puts the child in its own process group so killPidTree can
			// take the whole tree down, including anything the program spawned.
			// stdin is /dev/null, which is what makes System.in read EOF at once.
			child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
		} catch {
			resolve(null);
			return;
		}
		options.register(child);
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			resolve(code);
		};
		const feed = (stream: "stdout" | "stderr") => (data: Buffer) => {
			options.forward(stream, data.toString("utf8"));
			if (options.shouldStop() && child.pid) killPidTree(child.pid);
		};
		child.stdout?.on("data", feed("stdout"));
		child.stderr?.on("data", feed("stderr"));
		child.on("error", () => finish(null));
		child.on("close", code => finish(code));
	});
}

export async function runJava(options: RunJavaOptions): Promise<RunSummary> {
	const runId = randomUUID();
	const directory = mkdtempSync(join(tmpdir(), "pi-playground-"));
	const budget = new OutputBudget(options.limits.maxOutputBytes);
	const startedAt = Date.now();
	let timedOut = false;
	let aborted = false;
	let compileError = false;
	let exitCode: number | null = null;
	let current: ChildProcess | undefined;

	const forward = (stream: "stdout" | "stderr", chunk: string) => {
		const text = budget.push(chunk);
		if (text) options.onEvent({ type: "out", stream, text });
	};
	const shouldStop = () => timedOut || aborted || budget.exceeded;
	const stop = () => {
		if (current?.pid) killPidTree(current.pid);
	};

	options.onEvent({ type: "start", runId });
	const timer = setTimeout(() => {
		timedOut = true;
		stop();
	}, options.limits.timeoutMs);
	const onAbort = () => {
		aborted = true;
		stop();
	};
	options.signal.addEventListener("abort", onAbort, { once: true });

	try {
		const source = introspectJavaSource(options.code);
		const file = join(directory, source.fileName);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, options.code);

		const register = (child: ChildProcess) => {
			current = child;
		};
		// javac's diagnostics are parsed (`looksLikeMissingProjectDependency`) and shown
		// verbatim, so they must not change with the host locale: a Chinese macOS
		// emits `错误: 需要<标识符>`, which would silently disable that detection.
		const compiled = await spawnPhase(options.jdk.javac, ["-J-Duser.language=en", "-J-Duser.country=US", "-d", directory, file], { cwd: directory, forward, shouldStop, register });
		if (!shouldStop()) {
			if (compiled !== 0) compileError = true;
			else exitCode = await spawnPhase(options.jdk.java, [`-Xmx${options.limits.maxHeapMb}m`, "-cp", directory, source.mainClass], { cwd: directory, forward, shouldStop, register });
		}
	} catch (error) {
		options.onEvent({ type: "error", message: error instanceof Error ? error.message : "Run failed" });
	} finally {
		clearTimeout(timer);
		options.signal.removeEventListener("abort", onAbort);
		rmSync(directory, { recursive: true, force: true });
	}

	const summary: RunSummary = { runId, durationMs: Date.now() - startedAt, exitCode, compileError, timedOut, truncated: budget.exceeded, aborted };
	options.onEvent({ type: "end", exitCode: summary.exitCode, durationMs: summary.durationMs, truncated: summary.truncated, timedOut: summary.timedOut, compileError: summary.compileError });
	return summary;
}
