import type { SubagentSource } from "./sources.js";
import type { SubagentJob } from "./runner.js";
export interface SubagentPlanInput {
	question: string;
	scope?: "workspace" | "selected";
	tasks?: { title?: string; sourceId?: string; sourceIds?: string[]; task: string }[];
}
/** Task identity is independent of sources. Legacy question-only calls become one task. */
export function planSubagentJobs(sources: SubagentSource[], input: SubagentPlanInput, _covered: ReadonlySet<string> = new Set()): { jobs: SubagentJob[]; remainingSourceIds: string[] } {
	if ((input.tasks?.length ?? 0) > 8) throw Error("Subagent batch limit exceeded (8 tasks)");
	if (input.scope === "selected" && !input.tasks?.length) throw Error("Selected scope requires tasks with sources");
	const tasks = input.tasks?.length ? input.tasks : [{ task: input.question, sourceIds: sources.map(source => source.id) }];
	const jobs = tasks.map(task => {
		if (!task.task.trim()) throw Error("Each subagent needs a concrete task");
		const ids = [...new Set(task.sourceIds ?? (task.sourceId ? [task.sourceId] : []))];
		if (!ids.length || ids.length > 8) throw Error("Each task must select 1 to 8 sources; split larger investigations into explicit tasks");
		const selected = ids.map(id => {
			const source = sources.find(source => source.id === id);
			if (!source) throw Error(`Source is no longer available in this Workspace: ${id}. Call sources again.`);
			return source;
		});
		const instruction = [input.question, task.task].filter((text, index, all) => text.trim() && all.indexOf(text) === index).join("\n\n");
		if (instruction.length > 24000) throw Error("Combined task is too long; condense the instructions");
		return { source: selected[0], sources: selected, title: (task.title?.trim() || task.task.trim()).slice(0, 120), task: instruction };
	});
	return { jobs, remainingSourceIds: [] };
}
