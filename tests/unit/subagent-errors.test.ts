import { describe, expect, it } from "vitest";
import { planSubagentJobs } from "../../server/subagents/planning.js";
import { subagentErrorGroups, subagentErrorKind, subagentRetryArguments } from "../../web/src/subagent-errors.js";
import type { SubagentItemView } from "../../web/src/subagent-presentation.js";
const failed = (text: string): SubagentItemView => ({ sourceId: "repo:one", source: "One", root: "/one", task: "Investigate", phase: "failed", text });
describe("subagent error recovery", () => {
	it("groups known reasons without merging unrelated unknown errors", () => {
		const groups = subagentErrorGroups([failed("operation aborted"), failed("timeout"), failed("opaque A"), failed("opaque B"), failed("opaque A")]);
		expect(groups.map(group => group.items.length)).toEqual([1, 1, 2, 1]);
	});
	it("distinguishes explicit timeouts from unclassified interruption", () => {
		expect(subagentErrorKind(failed("This operation was aborted"))).toBe("interrupted");
		expect(subagentErrorKind(failed("Request timed out"))).toBe("timeout");
	});
	it("recognizes connection, rate, access and missing resource failures", () => {
		expect(["ECONNREFUSED 127.0.0.1", "429 Too Many Requests", "EACCES", "ENOENT"].map(text => subagentErrorKind(failed(text)))).toEqual(["connection", "rate", "permission", "missing"]);
	});
	it("retains original question and tasks but revalidates workspace on sending", () => {
		expect(JSON.parse(subagentRetryArguments([failed("abort")], JSON.stringify({question:"Why?", workspaceId:"old", scope:"workspace"})))).toEqual({action:"run",scope:"selected",question:"Why?",tasks:[{sourceId:"repo:one",task:"Why?"}]});
	});
	it("round-trips the original task without injecting the question twice", () => {
		const source = { id: "repo:one", name: "One", root: "/one", kind: "repository" as const };
		const original = { action: "run", question: "Why?", tasks: [{ title: "Entry", sourceIds: [source.id], task: "Find entry" }] };
		const retry = JSON.parse(subagentRetryArguments([{ ...failed("abort"), title: "Entry", sources: [source], task: "Why?\n\nFind entry" }], JSON.stringify(original)));
		expect(retry.tasks).toEqual(original.tasks);
		expect(planSubagentJobs([source], retry).jobs[0].task).toBe("Why?\n\nFind entry");
	});
});

it("refuses ambiguous historical retries instead of sending a clipped preview", () => {
	const args = { action: "run", question: "context".repeat(100), tasks: [{ sourceId: "repo:one", task: "First" }, { sourceId: "repo:one", task: "Second" }] };
	expect(() => subagentRetryArguments([{ ...failed("abort"), task: "context…" }], JSON.stringify(args))).toThrow();
});

it("restores each full indexed task after long shared context was clipped", () => {
	const tasks = [{ sourceId: "repo:one", task: "First full instruction" }, { sourceId: "repo:one", task: "Second full instruction" }];
	const args = JSON.stringify({ action: "run", question: "background".repeat(1000), tasks });
	for (const taskIndex of [0, 1]) expect(JSON.parse(subagentRetryArguments([{ ...failed("abort"), taskIndex, task: "background…" }], args)).tasks).toEqual([tasks[taskIndex]]);
});

it("recovers the implicit user question from full detail, never a clipped snapshot", () => {
	const args = JSON.stringify({ action: "run", tasks: [{ sourceId: "repo:one", task: "Read entry" }] });
	const item = { ...failed("abort"), taskIndex: 0, task: "Background…" };
	expect(() => subagentRetryArguments([item], args)).toThrow(/context/);
	const retry = JSON.parse(subagentRetryArguments([item], args, "Original user background\n\nRead entry"));
	expect(retry.question).toBe("Original user background");
	expect(retry.tasks[0].task).toBe("Read entry");
});
