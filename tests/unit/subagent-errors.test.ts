import { describe, expect, it } from "vitest";
import { planSubagentJobs } from "../../server/subagents/planning.js";
import { subagentErrorGroups, subagentErrorKind, subagentRetryArguments } from "../../web/src/subagent-errors.js";
import type { SubagentItemView } from "../../web/src/subagent-presentation.js";
const failed = (text: string): SubagentItemView => ({ sourceId: "repo:one", source: "One", root: "/one", task: "Investigate", phase: "failed", text });
describe("subagent error recovery", () => {
	it("groups known reasons without merging unrelated unknown errors", () => {
		const groups = subagentErrorGroups([failed("operation aborted"), failed("timeout"), failed("opaque A"), failed("opaque B"), failed("opaque A")]);
		expect(groups.map(group => group.items.length)).toEqual([2, 2, 1]);
	});
	it("recognizes connection, rate, access and missing resource failures", () => {
		expect(["ECONNREFUSED 127.0.0.1", "429 Too Many Requests", "EACCES", "ENOENT"].map(text => subagentErrorKind(failed(text)))).toEqual(["connection", "rate", "permission", "missing"]);
	});
	it("retains original question and tasks but revalidates workspace on sending", () => {
		expect(JSON.parse(subagentRetryArguments([failed("abort")], JSON.stringify({question:"Why?", workspaceId:"old", scope:"workspace"})))).toEqual({action:"run",scope:"selected",question:"Why?",tasks:[{sourceId:"repo:one",task:"Investigate"}]});
	});
	it("round-trips the original task without injecting the question twice", () => {
		const source = { id: "repo:one", name: "One", root: "/one", kind: "repository" as const };
		const original = { action: "run", question: "Why?", tasks: [{ title: "Entry", sourceIds: [source.id], task: "Find entry" }] };
		const retry = JSON.parse(subagentRetryArguments([{ ...failed("abort"), title: "Entry", sources: [source], task: "Why?\n\nFind entry" }], JSON.stringify(original)));
		expect(retry.tasks).toEqual(original.tasks);
		expect(planSubagentJobs([source], retry).jobs[0].task).toBe("Why?\n\nFind entry");
	});
});
