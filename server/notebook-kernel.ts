import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createPythonProbe } from "./playground-python.js";
import { PlaygroundConfigStore, playgroundEnvLock } from "./playground-config.js";
import { PythonTools } from "./playground-python-tools.js";
import { killPidTree } from "./process-utils.js";
import type { NotebookCellOutput } from "./protocol.js";

const script = ["../assets/notebook/kernel.py", "../../assets/notebook/kernel.py"]
	.map((p) => fileURLToPath(new URL(p, import.meta.url)))
	.find(existsSync)!;
function launch(command: string, target: string, file: string) {
	const child = spawn(command, ["-I", "-u", script, target], {
		cwd: dirname(file),
		detached: true,
		windowsHide: true,
		stdio: "pipe",
	});
	let error = "",
		receive: ((line: string) => void) | undefined,
		rejectRun: ((error: Error) => void) | undefined,
		closePromise: Promise<void> | undefined;
	child.stderr.on("data", (data) => {
		error = (error + data).slice(-2000);
	});
	child.stdin.on("error", () => {});
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => receive?.(line));
	function fail(reason: Error) {
		rejectRun?.(reason);
	}
	child.on("error", fail);
	child.on("close", () => fail(new Error(error || "Kernel stopped")));
	function close(): Promise<void> {
		if (closePromise) return closePromise;
		child.stdin.end();
		const timer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null && child.pid) killPidTree(child.pid);
		}, 2000);
		timer.unref();
		closePromise = new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				clearTimeout(timer);
				resolve();
				return;
			}
			child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		return closePromise;
	}
	let last = Date.now();
	return {
		close,
		dead: () => child.exitCode !== null || child.signalCode !== null,
		idle: () => !receive && Date.now() - last > 600000,
		interrupt: () => child.stdin.write('{"interrupt":true}\n'),
		async run(code: string, timeout: number, publish?: (event: NotebookCellOutput) => void) {
			if (receive) throw new Error("Kernel busy");
			let count = 0,
				bytes = 0;
			const outputs: NotebookCellOutput[] = [];
			const timer = setTimeout(() => {
				fail(new Error("Kernel timeout"));
				close();
			}, timeout + 30000);
			try {
				await new Promise<void>((resolve, reject) => {
					rejectRun = reject;
					receive = (line) => {
						try {
							bytes += Buffer.byteLength(line);
							if (bytes > 8 * 1024 * 1024) throw new Error("Cell output exceeds 8 MiB");
							const event = JSON.parse(line);
							if (event.output) publish?.(event.output);
							if (event.done) resolve();
							else if (event.count) count = event.count;
							else if (event.output?.output_type === "clear_output") outputs.length = 0;
							else if (event.output) {
								delete event.output.transient;
								outputs.push(event.output);
							}
						} catch (e) {
							reject(e);
							close();
						}
					};
					child.stdin.write(JSON.stringify({ code }) + "\n");
				});
				return { outputs, execution_count: count };
			} finally {
				last = Date.now();
				clearTimeout(timer);
				receive = rejectRun = undefined;
			}
		},
	};
}
export function notebookKernels(dataDir: string) {
	const lifetime = new AbortController();
	const kernels = new Map<string, ReturnType<typeof launch>>();
	const probe = createPythonProbe(),
		tools = new PythonTools(dataDir, true),
		settings = new PlaygroundConfigStore(join(dataDir, "playground.json"));
	const timer = setInterval(() => {
		for (const [k, v] of kernels)
			if (v.dead() || v.idle()) {
				void v.close();
				kernels.delete(k);
			}
	}, 30000);
	timer.unref();
	return {
		async close() {
			lifetime.abort();
			clearInterval(timer);
			const active = [...kernels.values()];
			kernels.clear();
			await Promise.all(active.map(kernel => kernel.close()));
		},
		async request(key: string, file: string, action: string, code: unknown, publish?: (event: NotebookCellOutput) => void) {
			let kernel = kernels.get(key);
			if (action === "notebook-close") {
				if (kernel) await kernel.close();
				kernels.delete(key);
				return {};
			}
			if (action === "notebook-interrupt") {
				kernel?.interrupt();
				return {};
			}
			const python = await probe.get(),
				config = settings.read(python.available);
			if (!python.available || !python.command) throw new Error("Python 3.9+ required");
			if (!config.enabled || playgroundEnvLock(process.env)) throw new Error("Python execution disabled");
			const interpreter = { command: python.command, args: python.args ?? [] };
			if (action === "notebook-install") {
				await tools.install(interpreter, lifetime.signal);
				return {};
			}
			if (action !== "notebook-run" || typeof code !== "string" || Buffer.byteLength(code) > 262144)
				throw new Error("Invalid notebook request");
			kernel = kernels.get(key);
			if (!kernel || kernel.dead()) {
				if (!kernel && kernels.size >= config.maxConcurrent) throw new Error("Notebook kernel limit reached");
				kernel = launch(python.command, tools.path(interpreter) ?? "", file);
				kernels.set(key, kernel);
			}
			return kernel.run(code, config.timeoutMs, publish);
		},
	};
}
