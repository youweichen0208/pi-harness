import { describe, expect, it } from "vitest";
import { subagentPresentation } from "../../web/src/subagent-presentation.js";
import type { UiSubagentProgress } from "../../server/protocol.js";
import type { ProjectedSubagentResult } from "../../server/subagents/results.js";
import type { SubagentResult } from "../../server/subagents/runner.js";

const tasks = [
	{ sourceId: "repository:a", task: "Inspect the order flow" },
	{ sourceId: "repository:a", task: "Inspect refund errors" },
	{ sourceId: "knowledge:handbook", task: "Check the refund policy" },
];
const args = JSON.stringify({ action: "run", tasks });

function live(index: number, overrides: Partial<UiSubagentProgress> = {}): UiSubagentProgress {
	return {
		sourceId: tasks[index].sourceId,
		source: index === 2 ? "Handbook" : "Orders",
		root: index === 2 ? "/workspace/handbook" : "/workspace/orders",
		task: tasks[index].task,
		phase: "running",
		tool: "source_search",
		...overrides,
	};
}

function identity(index: number) {
	const item = live(index);
	return { sourceId: item.sourceId, source: item.source, root: item.root, task: item.task };
}

function result(index: number): ProjectedSubagentResult {
	return {
		...identity(index),
		status: "completed",
		text: "The orderId links the refund request to its completion.",
		evidenceStatus: "checked",
		evidenceWarning: "Sibling findings still require synthesis.",
		durationMs: 1250,
		truncated: true,
		outputTruncated: true,
		omittedFindings: 2,
		omittedConnections: 1,
		omittedOpenQuestions: 3,
		usage: { input: 120, output: 30, cacheRead: 12, cacheWrite: 4, cost: 0.0123 },
		report: {
			summary: "Refund requests and completions share orderId.",
			findings: [{
				kind: index === 2 ? "documentation" : "implementation",
				statement: "The completion event carries orderId.",
				citations: [{ evidenceId: "ev_not_forwarded_to_view", path: "evidence.md", startLine: 2, endLine: 4, sha256: "a".repeat(64), excerpt: "POST /refund\nRefundCompleted(orderId)\nreturn result" }],
			}],
			connections: ["Compare the completion event with the policy."],
			openQuestions: ["Who reconciles a partial refund?"],
			checkedAt: "2026-10-26T08:00:00.000Z",
		},
	};
}

describe("subagentPresentation", () => {
	it("uses tasks as queued placeholders and merges live progress by array index", () => {
		expect(subagentPresentation(args, "")).toMatchObject({ final: false, items: tasks.map(task => ({ ...task, source: task.sourceId, root: "", phase: "queued" })) });
		const model = subagentPresentation(args, "partial output", [live(0), live(1, { phase: "queued", tool: undefined }), live(2, { tool: "source_read" })]);
		expect(model).toMatchObject({ final: false, items: [
			{ source: "Orders", root: "/workspace/orders", task: tasks[0].task, tool: "source_search" },
			{ source: "Orders", task: tasks[1].task, phase: "queued" },
			{ sourceId: "knowledge:handbook", source: "Handbook", task: tasks[2].task, tool: "source_read" },
		] });
		expect(model?.items[0].task).not.toBe(model?.items[1].task);
		expect(model?.items[1]).not.toHaveProperty("tool");
	});

	it("keeps a partial live snapshot for the remaining queued tasks", () => {
		const model = subagentPresentation(args, "", [live(0, { phase: "completed", tool: undefined }), live(1)]);
		expect(model?.items.map(item => item.phase)).toEqual(["completed", "running", "queued"]);
		expect(model?.items[2].source).toBe("knowledge:handbook");
	});

	it("projects final reports, citations, omissions, usage and workspace identity", () => {
		const output = JSON.stringify({ workspace: { id: "team", name: "Commerce" }, results: [result(0), result(1), result(2)] });
		const model = subagentPresentation(args, output, [live(0)]);
		expect(model).toMatchObject({ workspace: { id: "team", name: "Commerce" }, final: true });
		expect(model?.items).toHaveLength(3);
		expect(model?.items[0]).toMatchObject({ evidenceStatus: "checked", durationMs: 1250, truncated: true, outputTruncated: true, omittedFindings: 2, omittedConnections: 1, omittedOpenQuestions: 3, usage: { input: 120, output: 30, cacheRead: 12, cacheWrite: 4, cost: 0.0123 } });
		expect(model?.items[2].report).toEqual({
			summary: "Refund requests and completions share orderId.",
			findings: [{ kind: "documentation", statement: "The completion event carries orderId.", citations: [{ path: "evidence.md", startLine: 2, endLine: 4, excerpt: "POST /refund\nRefundCompleted(orderId)\nreturn result" }] }],
			connections: ["Compare the completion event with the policy."],
			openQuestions: ["Who reconciles a partial refund?"],
			checkedAt: "2026-10-26T08:00:00.000Z",
		});
	});

	it("retains failed and explicitly unverified results without inventing a report", () => {
		const failed: SubagentResult = { ...identity(0), status: "failed", text: "Provider unavailable", evidenceStatus: "unverified", evidenceWarning: "No evidence was submitted.", durationMs: 10, truncated: false };
		const unverified: SubagentResult = { ...identity(1), status: "completed", text: "A free-text answer", evidenceStatus: "unverified", durationMs: 20, truncated: false };
		const model = subagentPresentation(args, JSON.stringify({ results: [failed, unverified] }));
		expect(model).toMatchObject({ final: true, items: [{ phase: "failed", evidenceWarning: "No evidence was submitted." }, { phase: "completed", evidenceStatus: "unverified", text: "A free-text answer" }] });
		expect(model?.items.every(item => !item.report && !item.usage)).toBe(true);
	});

	it("falls back to the generic tool card for other actions or malformed data", () => {
		expect(subagentPresentation(JSON.stringify({ action: "sources" }), "")).toBeUndefined();
		expect(subagentPresentation(JSON.stringify({ action: "inspect", sourceIds: ["repository:a"] }), "")).toBeUndefined();
		expect(subagentPresentation("not json", "")).toBeUndefined();
		expect(subagentPresentation(JSON.stringify({ action: "run", tasks: [{ sourceId: "repository:a" }] }), "")).toBeUndefined();
		expect(subagentPresentation(JSON.stringify({ action: "run", tasks: [] }), "")).toBeUndefined();
		for (const mutate of [
			(value: Record<string, unknown>) => { (value.results as Record<string, unknown>[])[0].report = { summary: "missing fields" }; },
			(value: Record<string, unknown>) => { (value.results as Record<string, unknown>[])[0].usage = { input: 120 }; },
			(value: Record<string, unknown>) => { (value.results as Record<string, unknown>[])[0].status = "running"; },
			(value: Record<string, unknown>) => { (value.results as Record<string, unknown>[])[0].evidenceStatus = "trusted"; },
		]) {
			const value = { results: [result(0)] };
			mutate(value);
			expect(subagentPresentation(args, JSON.stringify(value), [live(0)])).toBeUndefined();
		}
	});
});
