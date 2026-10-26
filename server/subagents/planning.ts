import type { SubagentSource } from "./sources.js";
import type { SubagentJob } from "./runner.js";
export interface SubagentPlanInput {
	question: string;
	scope?: "workspace" | "selected";
	tasks?: { sourceId: string; task: string }[];
}
/** One source owns one investigation. Workspace coverage is paged, never silently clipped. */
export function planSubagentJobs(sources: SubagentSource[], input: SubagentPlanInput, covered: ReadonlySet<string>): { jobs: SubagentJob[]; remainingSourceIds: string[] } {
	if ((input.tasks?.length ?? 0) > 8) throw Error("Subagent batch limit exceeded (8 task instructions)");
	if (!input.question.trim()) throw Error("A concrete research question is required");
	const tasks = new Map<string, string[]>();
	for (const task of input.tasks ?? []) {
		if (!sources.some(source => source.id === task.sourceId)) throw Error(`Source is no longer available in this Workspace: ${task.sourceId}. Call sources again.`);
		if (!task.task.trim()) throw Error("Each subagent needs a concrete task");
		tasks.set(task.sourceId, [...(tasks.get(task.sourceId) ?? []), task.task]);
	}
	if (input.scope === "selected" && !tasks.size) throw Error("Selected scope requires tasks with sourceId and task");
	const selected = input.scope === "selected" ? sources.filter(source => tasks.has(source.id)) : sources.filter(source => !covered.has(source.id));
	// Instructions are limited to eight sources: run those first so paging cannot lose them.
	if (input.scope !== "selected") selected.sort((a, b) => Number(tasks.has(b.id)) - Number(tasks.has(a.id)));
	const jobs = selected.slice(0, 8).map(source => {
		const instructions = tasks.get(source.id) ?? [];
		const task = [input.question, ...instructions].join("\n\n");
		if (task.length > 24000) throw Error(`Combined task for ${source.name} is too long; condense this source's instructions`);
		return { source, task };
	});
	return { jobs, remainingSourceIds: selected.slice(8).map(source => source.id) };
}
