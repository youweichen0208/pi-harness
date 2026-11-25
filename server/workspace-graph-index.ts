import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { GraphEdge, GraphNode } from "./protocol.js";

export interface GraphIndexSource { id: string; root: string }
export interface GraphRepoIndex {
	id: string;
	fingerprint: string;
	files: Record<string, string>;
	nodes: GraphNode[];
	edges: GraphEdge[];
}
export interface GraphIndexResult {
	repositories: GraphRepoIndex[];
	nodes: GraphNode[];
	edges: GraphEdge[];
}
export interface GraphJob {
	op: "build" | "fingerprint";
	sources: GraphIndexSource[];
	previous: GraphRepoIndex[];
}

const idle = { build: Promise.resolve(), fingerprint: Promise.resolve() };

function runWorker<T>(job: GraphJob, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	const options = { workerData: job, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 2048 } };
	let worker: Worker;
	if (import.meta.url.endsWith(".ts")) {
		// A source checkout needs tsx's ESM resolver for .js specifiers in .ts files.
		const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
		const entry = new URL("./workspace-graph-worker.ts", import.meta.url).href;
		worker = new Worker(`import(${JSON.stringify(loader)}).then(m => m.tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}))`, { ...options, eval: true });
	} else worker = new Worker(new URL("./workspace-graph-worker.js", import.meta.url), options);
	return new Promise((resolve, reject) => {
		let result: T, error: Error | undefined;
		const cancel = () => { error = new Error("Workspace Graph operation cancelled."); void worker.terminate(); };
		const timer = setTimeout(() => { error = new Error("Workspace Graph exceeded 120 seconds."); void worker.terminate(); }, 120_000);
		signal?.addEventListener("abort", cancel, { once: true });
		worker.once("message", (reply: { ok: true; result: T } | { ok: false; error: string }) => {
			if (reply.ok) result = reply.result;
			else error = new Error(reply.error);
		});
		worker.once("error", () => { error ??= new Error("Workspace Graph worker failed or exceeded its memory limit."); });
		worker.once("exit", code => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			if (error || code !== 0 || result === undefined) reject(error ?? new Error("Workspace Graph worker exited before completing."));
			else resolve(result);
		});
	});
}

function enqueue<T>(job: GraphJob, signal?: AbortSignal): Promise<T> {
	// A full TypeScript checker can occupy a large part of a desktop's memory.
	const result = idle[job.op].then(() => runWorker<T>(job, signal));
	idle[job.op] = result.then(() => {}, () => {});
	return result;
}

export function indexWorkspaceGraph(sources: GraphIndexSource[], previous: GraphRepoIndex[] = [], signal?: AbortSignal): Promise<GraphIndexResult> {
	return enqueue({ op: "build", sources, previous }, signal);
}
export function fingerprintGraphSources(sources: GraphIndexSource[], signal?: AbortSignal): Promise<Record<string, string>> {
	return enqueue({ op: "fingerprint", sources, previous: [] }, signal);
}
