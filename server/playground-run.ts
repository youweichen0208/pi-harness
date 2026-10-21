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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PlaygroundEvent, PlaygroundLimits, PlaygroundTests, PlaygroundCaseResult } from "./protocol.js";
import { killPidTree } from "./process-utils.js";
import { OutputBudget, introspectJavaSource, looksLikeMissingProjectDependency, wrapBareStatements } from "./playground-source.js";
import { discoverJavaMethods, validateCases } from "./playground-methods.js";
import { methodRunnerSource } from "./playground-method-runner.js";
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
	tests?: PlaygroundTests;
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
	/** The failure looks like it needs the rest of the project (see `looksLikeMissingProjectDependency`). */
	needsProject: boolean;
	timedOut: boolean;
	truncated: boolean;
	aborted: boolean;
}

/** Enough of the tail of stderr to classify a compiler failure, not to keep it.
 *  Counted in characters, not bytes — the classification only needs javac's
 *  summary, which lands at the end, so an approximate bound is fine. */
const STDERR_TAIL = 16_384;

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
		// Detached descendants belong to this execution even if the parent exits
		// successfully. On POSIX the process group survives its leader.
		child.on("exit", () => { if (child.pid && process.platform !== "win32") killPidTree(child.pid); });
		child.on("close", code => finish(code));
	});
}

export async function runJava(options: RunJavaOptions): Promise<RunSummary> {
	const runId = randomUUID();
	const directory = mkdtempSync(join(tmpdir(), "pi-playground-"));
	const budget = new OutputBudget(options.limits.maxOutputBytes);
	const startedAt = Date.now();
	let timedOut = false;
	let aborted = options.signal.aborted;
	const completedCases = new Set<string>();
	let compileError = false;
	let exitCode: number | null = null;
	let current: ChildProcess | undefined;
	// javac puts its summary last, so the tail is what identifies a failure that
	// needs the rest of the project rather than a mistake in the snippet.
	let stderrTail = "";

	const forward = (stream: "stdout" | "stderr", chunk: string) => {
		const text = budget.push(chunk);
		if (!text) return;
		if (stream === "stderr") stderrTail = `${stderrTail}${text}`.slice(-STDERR_TAIL);
		options.onEvent({ type: "out", stream, text });
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
		// Bare statements (`System.out.println("hi");`) get a Main scaffold so a
		// scratchpad line compiles; a source that declares any type is untouched.
		const discovered = options.tests ? discoverJavaMethods(options.code) : undefined;
		const method = discovered?.methods.find(m => m.id === options.tests?.methodId);
		if (options.tests) {
			if (!method) throw new Error("The selected method no longer exists");
			validateCases(method, options.tests.cases);
		}
		const code = discovered?.code ?? wrapBareStatements(options.code);
		const source = discovered ? { fileName: discovered.fileName, mainClass: "" } : introspectJavaSource(code);
		const file = join(directory, source.fileName);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, code);

		const register = (child: ChildProcess) => {
			current = child;
			if (shouldStop()) stop();
		};
		const runnerName = `PiTest_${runId.replace(/-/g, "")}`;
		const sources = [file];
		if (method && options.tests) {
			const runnerFile = join(dirname(file), `${runnerName}.java`);
			writeFileSync(runnerFile, methodRunnerSource(runnerName, method, options.tests.cases, options.limits.maxOutputBytes));
			sources.push(runnerFile);
		}
		// javac's diagnostics are parsed (`looksLikeMissingProjectDependency`) and shown
		// verbatim, so they must not change with the host locale: a Chinese macOS
		// emits `错误: 需要<标识符>`, which would silently disable that detection.
		const compiled = shouldStop() ? null : await spawnPhase(options.jdk.javac, ["-J-Duser.language=en", "-J-Duser.country=US", "-proc:none", "-cp", directory, "-sourcepath", directory, "-d", directory, ...sources], { cwd: directory, forward, shouldStop, register });
		if (!shouldStop()) {
			if (compiled !== 0) compileError = true;
			else if (method && options.tests) {
				let failed = false;
				const packagePrefix = method.className.includes(".") ? method.className.slice(0, method.className.lastIndexOf(".") + 1) : "";
				for (const [index, test] of options.tests.cases.entries()) {
					if (shouldStop()) break;
					options.onEvent({ type: "case_start", id: test.id });
					const began = Date.now();
					const resultFile = join(directory, `result-${index}`);
					const code = await spawnPhase(options.jdk.java, [`-Xmx${options.limits.maxHeapMb}m`, "-cp", directory, packagePrefix + runnerName, String(index), resultFile], { cwd: directory, forward, shouldStop, register });
					if (shouldStop()) break;
					let result: PlaygroundCaseResult = { id: test.id, status: "error", error: `Process exited without a result (exit ${code})`, durationMs: Date.now() - began };
					try {
						if (statSync(resultFile).size > options.limits.maxOutputBytes) budget.push(" ".repeat(options.limits.maxOutputBytes + 1));
						else {
							const raw = readFileSync(resultFile, "utf8");
							if (raw.startsWith("overflow")) budget.push(" ".repeat(options.limits.maxOutputBytes + 1));
							else {
								budget.push(raw);
								const [status, actual, expected, error] = raw.split("\n");
								if (code === 0 && ["passed", "failed", "error", "unasserted"].includes(status) && error !== undefined) result = { id: test.id, status: status as PlaygroundCaseResult["status"], actual: Buffer.from(actual, "base64").toString("utf8"), expected: test.expected ? Buffer.from(expected, "base64").toString("utf8") : undefined, error: error ? Buffer.from(error, "base64").toString("utf8") : undefined, durationMs: Date.now() - began };
							}
						}
					} catch { /* Missing output (System.exit, VM failure) is a case error. */ }
					if (shouldStop()) break;
					failed ||= result.status === "failed" || result.status === "error";
					completedCases.add(test.id);
					options.onEvent({ type: "case_result", result });
				}
				exitCode = shouldStop() ? null : failed ? 1 : 0;
			}
			else exitCode = await spawnPhase(options.jdk.java, [`-Xmx${options.limits.maxHeapMb}m`, "-cp", directory, source.mainClass], { cwd: directory, forward, shouldStop, register });
		}
	} catch (error) {
		options.onEvent({ type: "error", message: error instanceof Error ? error.message : "Run failed" });
	} finally {
		clearTimeout(timer);
		options.signal.removeEventListener("abort", onAbort);
		rmSync(directory, { recursive: true, force: true });
	}

	return finishSummary();

	function finishSummary(): RunSummary {
		for (const test of options.tests?.cases ?? []) {
			if (!completedCases.has(test.id)) options.onEvent({ type: "case_result", result: { id: test.id, status: "skipped", durationMs: 0 } });
		}
		const summary: RunSummary = { runId, durationMs: Date.now() - startedAt, exitCode, compileError, needsProject: compileError && looksLikeMissingProjectDependency(stderrTail), timedOut, truncated: budget.exceeded, aborted };
		options.onEvent({ type: "end", exitCode: summary.exitCode, durationMs: summary.durationMs, truncated: summary.truncated, timedOut: summary.timedOut, compileError: summary.compileError, needsProject: summary.needsProject });
		return summary;
	}
}
