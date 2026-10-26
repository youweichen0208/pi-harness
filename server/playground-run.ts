import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaygroundEvent, PlaygroundLimits, PlaygroundTests, PlaygroundCaseResult } from "./protocol.js";
import { killPidTree } from "./process-utils.js";
import { OutputBudget, looksLikeMissingProjectDependency } from "./playground-source.js";
import { discoverPythonMethods, validateCases } from "./playground-methods.js";
import { PYTHON_RUNNER } from "./playground-python-scripts.js";
import type { PythonCommand } from "./playground-python.js";
import { StringDecoder } from "node:string_decoder";

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

export interface RunPythonOptions {
	code: string;
	tests?: PlaygroundTests;
	limits: PlaygroundLimits;
	python: PythonCommand;
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
 *  Counted in characters, not bytes — the classification only needs Python's
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
			// stdin is /dev/null, which is what makes Python stdin read EOF at once.
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
		const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
		const feed = (stream: "stdout" | "stderr") => (data: Buffer) => {
			options.forward(stream, decoders[stream].write(data));
			if (options.shouldStop() && child.pid) killPidTree(child.pid);
		};
		child.stdout?.on("data", feed("stdout"));
		child.stderr?.on("data", feed("stderr"));
		child.on("error", () => finish(null));
		// Detached descendants belong to this execution even if the parent exits
		// successfully. On POSIX the process group survives its leader.
		child.on("exit", () => { if (child.pid && process.platform !== "win32") killPidTree(child.pid); });
		child.on("close", code => { for (const stream of ["stdout", "stderr"] as const) options.forward(stream, decoders[stream].end()); finish(code); });
	});
}

export async function runPython(options: RunPythonOptions): Promise<RunSummary> {
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
	// Python puts its summary last, so the tail is what identifies a failure that
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
		const method = options.tests ? discoverPythonMethods(options.code).methods.find(m => m.id === options.tests?.methodId) : undefined;
		if (options.tests) {
			if (!method) throw new Error("The selected function no longer exists");
			validateCases(method, options.tests.cases);
		}
		const file = join(directory, "scratch.py");
		writeFileSync(file, options.code);
		const register = (child: ChildProcess) => { current = child; if (shouldStop()) stop(); };
		const execute = (mode: string, extra: string[] = []) => spawnPhase(options.python.command, [...options.python.args, "-I", "-X", "utf8", "-u", "-c", PYTHON_RUNNER, file, mode, ...extra], { cwd: directory, forward, shouldStop, register });
		const compiled = shouldStop() ? null : await execute("check");
		if (!shouldStop()) {
			if (compiled !== 0) { compileError = true; exitCode = compiled; }
			else if (method && options.tests) {
				let failed = false;
				for (const [index, test] of options.tests.cases.entries()) {
					if (shouldStop()) break;
					options.onEvent({ type: "case_start", id: test.id });
					const began = Date.now();
					const resultFile = join(directory, `result-${index}.json`);
					const configFile = join(directory, `case-${index}.json`);
					writeFileSync(configFile, JSON.stringify({ method, case: test }));
					const code = await execute("test", [configFile, resultFile, String(options.limits.maxOutputBytes)]);
					if (shouldStop()) break;
					let result: PlaygroundCaseResult = { id: test.id, status: "error", error: `Process exited without a result (exit ${code})`, durationMs: Date.now() - began };
					try {
						if (statSync(resultFile).size > options.limits.maxOutputBytes) budget.push(" ".repeat(options.limits.maxOutputBytes + 1));
						else {
							const raw = readFileSync(resultFile, "utf8");
							if (raw === "overflow") budget.push(" ".repeat(options.limits.maxOutputBytes + 1));
							else {
								budget.push(raw);
								const parsed = JSON.parse(raw);
								if (code === 0 && ["passed", "failed", "error", "unasserted"].includes(parsed.status)) result = { ...parsed, id: test.id, durationMs: Date.now() - began };
							}
						}
					} catch { /* A process that exits without its internal result is a case error. */ }
					if (shouldStop()) break;
					failed ||= result.status === "failed" || result.status === "error";
					completedCases.add(test.id);
					options.onEvent({ type: "case_result", result });
				}
				exitCode = shouldStop() ? null : failed ? 1 : 0;
			} else exitCode = await execute("program");
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
		const summary: RunSummary = { runId, durationMs: Date.now() - startedAt, exitCode, compileError, needsProject: looksLikeMissingProjectDependency(stderrTail), timedOut, truncated: budget.exceeded, aborted };
		options.onEvent({ type: "end", exitCode: summary.exitCode, durationMs: summary.durationMs, truncated: summary.truncated, timedOut: summary.timedOut, compileError: summary.compileError, needsProject: summary.needsProject });
		return summary;
	}
}
