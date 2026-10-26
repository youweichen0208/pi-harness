import { expect, test } from "vitest";
import { planSubagentJobs } from "../../server/subagents/planning.js";
import type { SubagentSource } from "../../server/subagents/sources.js";
const repo = (id: number): SubagentSource => ({ id: `repository:${id}`, kind: "repository", root: `/repo-${id}`, name: `repo-${id}` });
const library: SubagentSource = { id: "knowledge:library", kind: "knowledge", root: "/library", name: "library" };
test("default research covers each workspace repository and the knowledge library exactly once", () => {
	const planned = planSubagentJobs([repo(1), repo(2), library], { question: "Explain refunds", tasks: [{ sourceId: repo(1).id, task: "Find entry" }, { sourceId: repo(1).id, task: "Find callbacks" }] }, new Set());
	expect(planned.jobs.map(j => j.source.id)).toEqual([repo(1).id, repo(2).id, library.id]);
	expect(planned.jobs[0].task).toContain("Find entry"); expect(planned.jobs[0].task).toContain("Find callbacks");
	expect(planned.jobs.every(j => j.task.includes("Explain refunds"))).toBe(true);
	expect(planned.remainingSourceIds).toEqual([]);
});
test("large workspaces paginate without omitting or repeating sources", () => {
	const sources = [...Array.from({ length: 15 }, (_, i) => repo(i)), library], covered = new Set<string>();
	const first = planSubagentJobs(sources, { question: "Investigate" }, covered);
	expect(first.jobs).toHaveLength(8); expect(first.remainingSourceIds).toHaveLength(8);
	first.jobs.forEach(j => covered.add(j.source.id));
	const second = planSubagentJobs(sources, { question: "Investigate" }, covered);
	expect(second.jobs).toHaveLength(8); expect(second.remainingSourceIds).toEqual([]);
	expect(new Set([...first.jobs, ...second.jobs].map(j => j.source.id)).size).toBe(16);
});
test("explicit selected scope respects restrictions and permits follow-up on a covered source", () => {
	const planned = planSubagentJobs([repo(1), repo(2), library], { scope: "selected", question: "Investigate", tasks: [{ sourceId: repo(1).id, task: "Follow up" }, { sourceId: repo(1).id, task: "Check docs" }] }, new Set([repo(1).id]));
	expect(planned.jobs).toHaveLength(1); expect(planned.jobs[0].source.id).toBe(repo(1).id);
	expect(planned.remainingSourceIds).toEqual([]);
});
test("rejects stale source IDs and empty scope before any child starts", () => {
	expect(() => planSubagentJobs([repo(1)], { question: "q", tasks: [{ sourceId: "other", task: "task" }] }, new Set())).toThrow(/no longer available/);
	expect(() => planSubagentJobs([repo(1)], { scope: "selected", question: "q" }, new Set())).toThrow(/requires tasks/);
});

test("instructions for later sources run in the first page rather than being lost", () => {
	const sources = Array.from({ length: 16 }, (_, i) => repo(i));
	const first = planSubagentJobs(sources, { question: "Investigate", tasks: [{ sourceId: repo(15).id, task: "Check a specific callback" }] }, new Set());
	expect(first.jobs[0].source.id).toBe(repo(15).id);
	expect(first.jobs[0].task).toContain("Check a specific callback");
	expect(first.remainingSourceIds).not.toContain(repo(15).id);
});
