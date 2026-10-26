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
		description: "Automatically research project-specific questions using this Workspace's repositories and the configured pi-harness knowledge library: business rules, architecture, interfaces, data flows, behavior, causes and code/documentation differences. Users can ask ordinary questions without naming repositories or requesting subagents. First call action=sources to discover registered sources. Use action=inspect with selected sourceIds to read bounded repository overviews and file listings without starting child models when source responsibilities are unclear. Then action=run with a question defaults to Workspace-wide coverage: exactly one child per registered repository and one for the configured knowledge library. Duplicate tasks for a source are merged. For explicit user restrictions or focused follow-ups use scope=selected with tasks. Workspace runs return remainingSourceIds; repeat run with the same question until it is empty. Simple local questions and general knowledge need no delegation. Each task names exactly one sourceId. Up to 8 sources per inspection or tasks per batch, 3 children running in parallel, a per-request budget of max(12, source count + 4) children so every source can be covered. Children use the current model/thinking and incur model usage; each has fresh context, read-only source tools, and no shell, editing, plugins or delegation. Results include structured findings, checked citations when available, per-source errors and usage. Citation checking validates source text and fingerprints, not the truth of a conclusion. Waits for all children; parent cancellation stops them. Pass relevant question context in each task; children do not inherit this conversation. Follow up with another run when necessary, then synthesize and cite source root/file:line. Never treat partial/failed or unverified research as complete coverage.",
		promptSnippet: "Automatically investigate project questions with read-only Workspace and knowledge-library subagents when research benefits from delegation.",
		promptGuidelines: [
			"For project-specific questions about business rules, architecture, responsibilities, interfaces, data/state flows, behavior, causes, impact or code/documentation differences, assess intent from the question and conversation. Users do not need to mention subagents, name repositories or know that an answer spans repositories. Before substantial project research, call subagent action=sources unless a current source inventory is already available; discover scope rather than assuming the current repository contains the whole answer.",
			"For substantial project research, default to action=run with a self-contained question and scope=workspace (the default). The host assigns one child to every registered repository in the current Workspace and one to the configured knowledge library, merging instructions for the same source. Do not split one repository into several children instead of covering other repositories. Unrelated sources should report no relevant evidence. Repeat workspace run with the same question while remainingSourceIds is nonempty; completed source IDs are not dispatched again. For explicit user source restrictions, use scope=selected and tasks, and never widen that scope. Use selected scope for follow-up gaps after initial coverage. Missing knowledge-library configuration does not block repository research. inspect can clarify responsibilities but must not silently exclude other Workspace repositories from the initial default survey.",
			"Answer general knowledge, casual conversation and follow-ups already supported by current evidence directly. Read a known file or small local question directly when delegation adds no value. Respect explicit source restrictions and requests to work without subagents. When enabled, relevant read-only delegation needs no separate user confirmation. For coding requests, children may investigate but implementation remains with the parent.",
			"Give each child the question, relevant conversation context, a concrete investigation and expected file:line evidence. Children can submit structured findings with checked source citations. Use report.findings citations to distinguish implementation, documentation and inference; evidenceStatus=checked applies only to that report's cited text at checkedAt, not final prose, reasoning or currentness forever. Treat unverified fallback text and uncited connections as leads requiring further inspection. Connect repositories using evidence from both sides of an interface, event or entity rather than matching names alone. For code/documentation differences, cite each side and state applicability or missing evidence. Call out failed sources, truncation and unresolved questions; narrow follow-up research to those gaps rather than repeating completed investigations.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("sources"), Type.Literal("inspect"), Type.Literal("run")]),
			question: Type.Optional(Type.String({ minLength: 1, maxLength: 12000, description: "Self-contained question and conversation context for every source. Defaults to the latest user request." })),
			scope: Type.Optional(Type.Union([Type.Literal("workspace"), Type.Literal("selected")], { description: "Default workspace covers every registered repository plus knowledge, one child per source; selected requires tasks for explicit restrictions or follow-ups." })),
			workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "A Workspace ID from sources, needed when the current repository belongs to multiple Workspaces." })),
			sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 8, description: "Sources to inspect before selecting research tasks. Uses bounded local reads, no child models." })),
			tasks: Type.Optional(Type.Array(Type.Object({ sourceId: Type.String({ minLength: 1, maxLength: 160 }), task: Type.String({ minLength: 1, maxLength: 12000 }) }), { minItems: 1, maxItems: 8 })),
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
			for (const job of jobs) covered.add(job.source.id);
			const statuses: UiSubagentProgress[] = jobs.map(job => ({ sourceId: job.source.id, source: job.source.name, root: job.source.root, task: job.task, phase: "queued" }));
			const results = await runSubagents(jobs, { agentDir: bound.agentDir, model: bound.session.model, thinkingLevel: bound.session.thinkingLevel, modelRuntime: bound.session.modelRuntime },
				cancel, next => {
					statuses[next.index] = { ...statuses[next.index], phase: next.phase, tool: next.tool as UiSubagentProgress["tool"] };
					update?.({ content: [{ type: "text", text: statuses.map((status, index) => `${index + 1}. ${jobs[index].source.name}: ${status.phase}${status.tool ? ` · ${status.tool}` : ""}\n   ${jobs[index].task.slice(0, 240)}`).join("\n") }], details: { subagents: statuses } });
				});
			return { content: [{ type: "text", text: JSON.stringify({ workspace: sources.workspace, results: projectSubagentResults(results), remainingSourceIds, coverage: { attemptedSourceIds: [...covered], totalSources: sources.sources.length } }) }], details: { subagents: results } };
		},
	});
};
