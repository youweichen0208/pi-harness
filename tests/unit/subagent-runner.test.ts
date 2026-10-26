import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { runSubagent, runSubagents, type SubagentJob, type SubagentParent, type SubagentProgress, type SubagentResult } from "../../server/subagents/runner.js";

const { createAgentSession } = vi.hoisted(() => ({ createAgentSession: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
	...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(), createAgentSession,
}));

// Scheduler tests inject the child runner; it must forward this exact parent
// without inspecting or replacing its shared model/runtime configuration.
const parent = {} as SubagentParent;

function jobs(count: number): SubagentJob[] {
	return Array.from({ length: count }, (_, index) => ({
		source: { id: `repository:${index}`, name: `Repository ${index}`, root: join(tmpdir(), `subagent-runner-fixture-${index}`), kind: "repository" },
		task: `Investigate business area ${index}`,
	}));
}

function report(job: SubagentJob, status: SubagentResult["status"] = "completed"): SubagentResult {
	return { sourceId: job.source.id, source: job.source.name, root: job.source.root, task: job.task, status, text: `Report for ${job.source.id}`, durationMs: 1, truncated: false, evidenceStatus: "unverified" };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

async function microtasks() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => { createAgentSession.mockReset().mockRejectedValue(new Error("A scheduler unit test must never create a native model session")); });

describe("bounded subagent scheduler", () => {
	test("runs at most three children and preserves input order despite out-of-order completion", async () => {
		const tasks = jobs(7);
		const gates = tasks.map(() => deferred<SubagentResult>());
		const started: number[] = [], completed: number[] = [];
		const updates: SubagentProgress[] = [];
		let active = 0, peak = 0;
		const signal = new AbortController().signal;
		const run: typeof runSubagent = async (job, actualParent, actualSignal, progress) => {
			expect(actualParent).toBe(parent); expect(actualSignal).toBe(signal);
			const index = tasks.indexOf(job);
			started.push(index); peak = Math.max(peak, ++active);
			progress("source_search");
			try { return await gates[index].promise; }
			finally { active--; completed.push(index); }
		};
		const pending = runSubagents(tasks, parent, signal, update => updates.push(update), run);
		expect(started).toEqual([0, 1, 2]);
		expect(updates.slice(0, 7)).toEqual(tasks.map((_, index) => ({ index, phase: "queued" })));
		for (const index of [2, 1, 3, 0, 5, 4, 6]) {
			expect(started).toContain(index);
			gates[index].resolve(report(tasks[index]));
			await microtasks();
			expect(active).toBeLessThanOrEqual(3);
		}
		const results = await pending;
		expect(peak).toBe(3); expect(active).toBe(0);
		expect(completed).toEqual([2, 1, 3, 0, 5, 4, 6]);
		expect(results).toEqual(tasks.map(job => report(job)));
		expect(updates.filter(update => update.phase === "running")).toEqual(tasks.map((_, index) => ({ index, phase: "running", tool: "source_search" })));
		expect(updates.filter(update => update.phase === "completed").map(update => update.index)).toEqual(completed);
	});

	test("a thrown child and an explicit failed report preserve other sources and pending work", async () => {
		const tasks = jobs(5);
		const updates: SubagentProgress[] = [];
		const run: typeof runSubagent = async job => {
			if (job === tasks[1]) throw new Error("repository unavailable");
			return report(job, job === tasks[3] ? "failed" : "completed");
		};
		const results = await runSubagents(tasks, parent, new AbortController().signal, update => updates.push(update), run);
		expect(results.map(result => result.status)).toEqual(["completed", "failed", "completed", "failed", "completed"]);
		expect(results[1]).toMatchObject({ sourceId: tasks[1].source.id, source: tasks[1].source.name, root: tasks[1].source.root, task: tasks[1].task, text: expect.stringContaining("repository unavailable") });
		expect(results[4]).toEqual(report(tasks[4]));
		expect(updates.filter(update => update.phase === "failed").map(update => update.index).sort()).toEqual([1, 3]);
	});

	test("cancellation reaches active children and prevents queued children from starting work", async () => {
		const tasks = jobs(8);
		const abort = new AbortController();
		const updates: SubagentProgress[] = [];
		const started: number[] = [], aborted: number[] = [];
		const run: typeof runSubagent = async (job, _parent, signal, progress) => {
			signal.throwIfAborted();
			const index = tasks.indexOf(job); started.push(index); progress();
			await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { aborted.push(index); reject(signal.reason); }, { once: true }));
			return report(job);
		};
		const pending = runSubagents(tasks, parent, abort.signal, update => updates.push(update), run);
		expect(started).toEqual([0, 1, 2]);
		abort.abort(new Error("parent stopped"));
		const results = await pending;
		expect(started).toEqual([0, 1, 2]); expect(aborted).toEqual([0, 1, 2]);
		expect(results.map(result => result.status)).toEqual(tasks.map(() => "cancelled"));
		expect(results.every(result => result.text.includes("parent stopped"))).toBe(true);
		expect(updates.filter(update => update.phase === "cancelled")).toHaveLength(8);
		expect(updates.filter(update => update.phase === "running").map(update => update.index)).toEqual([0, 1, 2]);
	});

	test("already-cancelled native jobs never create an SDK session or report running", async () => {
		const tasks = jobs(5);
		const abort = new AbortController(); abort.abort(new Error("cancelled before dispatch"));
		const updates: SubagentProgress[] = [];
		const results = await runSubagents(tasks, parent, abort.signal, update => updates.push(update));
		expect(results.map(result => result.status)).toEqual(tasks.map(() => "cancelled"));
		expect(results.every(result => result.text.includes("cancelled before dispatch"))).toBe(true);
		expect(updates.some(update => update.phase === "running")).toBe(false);
		expect(createAgentSession).not.toHaveBeenCalled();
	});

	test("returns immediately for an empty batch without child or progress callbacks", async () => {
		const run = vi.fn<typeof runSubagent>(), update = vi.fn();
		expect(await runSubagents([], parent, new AbortController().signal, update, run)).toEqual([]);
		expect(run).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
	});
});
