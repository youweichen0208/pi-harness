import { expect, test } from "vitest";
import { planSubagentJobs } from "../../server/subagents/planning.js";
import type { SubagentSource } from "../../server/subagents/sources.js";
const repo = (id: number): SubagentSource => ({ id: `repository:${id}`, kind: "repository", root: `/repo-${id}`, name: `repo-${id}` });
test("tasks sharing a repository remain independent and do not survey unrelated sources", () => {
	const result = planSubagentJobs([repo(1), repo(2)], { question: "Explain refunds", tasks: [{ sourceId: repo(1).id, task: "Find entry" }, { sourceId: repo(1).id, task: "Find callbacks" }] });
	expect(result.jobs).toHaveLength(2);
	expect(result.jobs.map(job => job.sources?.map(source => source.id))).toEqual([[repo(1).id], [repo(1).id]]);
	expect(result.jobs[0].task).not.toContain("Find callbacks");
});
test("one task can select multiple sources and deduplicates only its source list", () => {
	const result = planSubagentJobs([repo(1), repo(2)], { question: "Compare", tasks: [{ title: "API comparison", sourceIds: [repo(2).id, repo(1).id, repo(2).id], task: "Compare endpoints" }] });
	expect(result.jobs[0].title).toBe("API comparison");
	expect(result.jobs[0].sources).toEqual([repo(2), repo(1)]);
});
test("legacy question-only invocation creates one bounded multi-source task", () => {
	expect(planSubagentJobs([repo(1), repo(2)], { question: "Investigate" }).jobs).toHaveLength(1);
	expect(() => planSubagentJobs(Array.from({ length: 9 }, (_, i) => repo(i)), { question: "Investigate" })).toThrow(/1 to 8 sources/);
});
test("rejects invalid scope and sources before starting children", () => {
	for (const task of [{ sourceIds: ["other"], task: "task" }, { sourceIds: [], task: "task" }, { sourceId: repo(1).id, task: " " }]) expect(() => planSubagentJobs([repo(1)], { question: "q", tasks: [task] })).toThrow();
	expect(() => planSubagentJobs([repo(1)], { scope: "selected", question: "q" })).toThrow(/requires tasks/);
});
