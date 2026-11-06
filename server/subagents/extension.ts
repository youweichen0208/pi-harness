import { TaskRecord } from "./tasks.js";
import { planSubagentJobs } from "./planning.js";
import { Type } from "typebox";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readSubagentSources } from "./sources.js";
import { runSubagents } from "./runner.js";
import { subagentSettings } from "./settings.js";
import { TOOL_TEXT_CONTINUE_PROMPT } from "../tool-text.js";
import { inspectSubagentSources } from "./inspect.js";
import { projectSubagentResults } from "./results.js";
import type { UiSubagentProgress } from "../protocol.js";

export interface SubagentHost { session: AgentSession; agentDir: string; workspaceId?: string }

/** Read merged raw settings: resolved getDefaultTools() loses whether the user
 * supplied an allowlist or only modifiers such as +codemode. */
export function subagentDefaultActive(defaultTools: unknown): boolean {
	if (defaultTools === undefined) return true;
	if (!Array.isArray(defaultTools)) return false;
	const entries = defaultTools.filter((entry): entry is string => typeof entry === "string");
	const plain = entries.filter(entry => !entry.startsWith("+") && !entry.startsWith("-"));
	let active = plain.length === 0 && entries.length > 0 || plain.some(pattern => new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test("subagent"));
	// Native modifiers use exact names, not glob exclusions.
	for (const entry of entries) {
		if (entry === "+subagent") active = true;
		if (entry === "-subagent") active = false;
	}
	return active;
}

export const createSubagentExtension = (host: () => SubagentHost | undefined = () => undefined, defaultTools: () => unknown = () => undefined): ExtensionFactory => pi => {
	let spawned = 0;
	const covered = new Set<string>();
	let requestKey = "";
	let lifetime = new AbortController();
	pi.on("session_shutdown", () => { lifetime.abort(); });
	pi.on("session_start", () => { if (lifetime.signal.aborted) lifetime = new AbortController(); });
	pi.registerTool({
		name: "subagent", label: "Workspace subagents",
		defaultActive: subagentDefaultActive(defaultTools()),
		exposure: subagentSettings().enabled && subagentDefaultActive(defaultTools()) ? "model-only" : "hidden", executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		description: "Delegate focused read-only investigation tasks to subagents. First call sources to discover this Workspace's repositories and knowledge library; inspect reads bounded overviews without spawning models. For run, provide explicit tasks with title, task and sourceIds. Tasks are independent: multiple tasks can use the same source, and one task may compare up to 8 selected sources. Select only relevant sources unless the user asks for complete coverage. Up to 8 tasks per batch, 3 running concurrently. Children inherit your model/thinking, incur usage, cannot edit, execute commands or delegate, and must perform real investigation. Waits for all tasks and returns their results; synthesize the final answer yourself. Failed tasks and unverified results are not completed research.",
		promptSnippet: "Delegate focused investigation tasks with explicit source boundaries when this helps answer the user's question.",
		promptGuidelines: [
			"Before substantial project research, call subagent action=sources unless a current inventory is available. Use inspect when source responsibilities are unclear. Users can ask ordinary questions without naming repositories or requesting subagents.",
			"Use action=run with tasks containing a short title, self-contained task instructions, and sourceIds from sources. Split by task, never by a mandatory one-agent-per-repository rule. Multiple independent tasks may share a repository; a cross-repository task may select multiple sources. Do not automatically survey all sources. Respect explicit source restrictions and requests to work without subagents. When full Workspace coverage is requested, arrange explicit tasks to cover it.",
			"Children investigate read-only; implementation stays with the parent. Simple local questions need no delegation. Every child must successfully list, search or read before finishing. Only actual tool events form the execution record. No automatic retry or continuation is provided.",
			"After the batch returns, synthesize the task results, distinguish implementation/documentation/inference, and cite source/file:line. Checked citations establish observed text and fingerprints, not the correctness of conclusions. Report failures, truncation and open questions. Follow up with explicit new tasks when necessary.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("sources"), Type.Literal("inspect"), Type.Literal("run")]),
			question: Type.Optional(Type.String({ minLength: 1, maxLength: 12000, description: "Self-contained question and conversation context for every source. Defaults to the latest user request." })),
			scope: Type.Optional(Type.Union([Type.Literal("workspace"), Type.Literal("selected")], { description: "Legacy scope compatibility. Prefer explicit tasks with sourceIds." })),
			workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "A Workspace ID from sources, needed when the current repository belongs to multiple Workspaces." })),
			sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 8, description: "Sources to inspect before selecting research tasks. Uses bounded local reads, no child models." })),
			tasks: Type.Optional(Type.Array(Type.Object({ title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 8 })), sourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), task: Type.String({ minLength: 1, maxLength: 12000 }) }), { minItems: 1, maxItems: 8 })),
		}),
		async execute(_id, args, signal, update, ctx) {
			if (!subagentSettings().enabled) throw Error("Workspace subagents are disabled");
			if (!subagentDefaultActive(defaultTools())) throw Error("Workspace subagents are excluded by native defaultTools");
			const user = ctx.sessionManager.getBranch().findLast(entry => {
				if (entry.type !== "message" || entry.message.role !== "user") return false;
				const content = entry.message.content;
				return (typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n")) !== TOOL_TEXT_CONTINUE_PROMPT;
			});
			const nextKey = `${ctx.sessionManager.getSessionId()}:${user?.id ?? ""}`;
			if (requestKey !== nextKey) { spawned = 0; covered.clear(); requestKey = nextKey; }
			const bound = host();
			const sources = readSubagentSources(ctx.cwd, args.workspaceId ?? bound?.workspaceId);
			if (args.action === "sources") return { content: [{ type: "text", text: JSON.stringify(sources, null, 2) }], details: {} };
			if (sources.issue) throw Error(`Workspace selection required: ${sources.issue}. Call sources and select a matching workspaceId.`);
			const cancel = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
			if (args.action === "inspect") {
				if (!args.sourceIds?.length || args.sourceIds.length > 8) throw Error("inspect requires 1 to 8 sourceIds from sources");
				const selected = [...new Set(args.sourceIds)].map(id => {
					const source = sources.sources.find(source => source.id === id);
					if (!source) throw Error(`Source is no longer available in this Workspace: ${id}. Call sources again.`);
					return source;
				});
				const inspections = await inspectSubagentSources(selected, cancel);
				return { content: [{ type: "text", text: JSON.stringify({ workspace: sources.workspace, inspections }) }], details: {} };
			}
			const userContent = user?.type === "message" && user.message.role === "user" ? user.message.content : "";
			const question = args.question ?? (typeof userContent === "string" ? userContent : userContent.filter(part => part.type === "text").map(part => part.text).join("\n")).slice(0, 12000);
			const { jobs, remainingSourceIds } = planSubagentJobs(sources.sources, { question, scope: args.scope, tasks: args.tasks }, covered);
			if (!bound?.session.model) throw Error("Parent model is unavailable");
			const requestBudget = Math.max(12, sources.sources.length + 4);
			if (spawned + jobs.length > requestBudget) throw Error(`Subagent request budget exceeded (${requestBudget} children); synthesize the available evidence`);

			spawned += jobs.length;
			for (const job of jobs) for (const source of job.sources ?? [job.source]) covered.add(source.id);
			const statuses: UiSubagentProgress[] = jobs.map((job, taskIndex) => ({ taskIndex, title: job.title, sources: job.sources, sourceId: job.source.id, source: job.source.name, root: job.source.root, task: job.task, phase: "queued" }));
			const publish = () => update?.({ content: [{ type: "text", text: statuses.map(status => `${status.title}: ${status.phase}${status.tool ? ` · ${status.tool}` : ""}`).join("\n") }], details: { subagents: statuses } });
			for (const [index, job] of jobs.entries()) {
				job.record = new TaskRecord(ctx.sessionManager.getSessionId(), _id, user?.id ?? "", statuses[index], task => { statuses[index] = task; publish(); });
				statuses[index] = job.record.data.task;
			}
			const results = await runSubagents(jobs, { agentDir: bound.agentDir, model: bound.session.model, thinkingLevel: bound.session.thinkingLevel, modelRuntime: bound.session.modelRuntime },
				cancel, next => jobs[next.index].record!.update({ phase: next.phase, tool: next.tool as UiSubagentProgress["tool"], ...(next.steps ? { steps: next.steps } : {}) }));
			return { content: [{ type: "text", text: JSON.stringify({ workspace: sources.workspace, results: projectSubagentResults(results), remainingSourceIds, coverage: { attemptedSourceIds: [...covered], totalSources: sources.sources.length } }) }], details: { subagents: results } };
		},
	});
};
