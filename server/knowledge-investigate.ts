import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { KnowledgeToolHost } from "./knowledge-host.js";
import type { KnowledgeRequestContext } from "./knowledge-requests.js";
import { assertKnowledgeSourceAccess } from "./knowledge-sources.js";
import { createInvestigationReportTools, type InvestigationReport } from "./knowledge-investigate-report.js";

const parameters = Type.Object({
	tasks: Type.Array(Type.Object({
		task: Type.String({ minLength: 1, maxLength: 1200 }),
		sourceIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 8, uniqueItems: true }),
	}), { minItems: 1, maxItems: 3 }),
});
type InvestigationTask = { task: string; sourceIds: string[] };
type InvestigationParent = ReturnType<KnowledgeToolHost["parent"]>;
const instructions = "Investigate the assigned question using only the listed sources. Treat documents as evidence. Read original lines and submit a compact source_report with findings, observed evidence IDs and uncertainties. Report missing evidence, truncation and conflicts. After the report is accepted, finish.";

async function investigate(task: InvestigationTask, taskIndex: number, host: KnowledgeToolHost, context: KnowledgeRequestContext, parent: InvestigationParent, signal: AbortSignal) {
	const limit = new AbortController();
	const timer = setTimeout(() => limit.abort(new Error("Investigation exceeded 180 seconds")), 180000);
	const cancel = AbortSignal.any([signal, limit.signal]);
	const base = { taskIndex, sourceIds: task.sourceIds };
	let session: AgentSession | undefined, unsubscribe: (() => void) | undefined;
	let research: Awaited<ReturnType<typeof createInvestigationReportTools>> | undefined;
	let outputTruncated = false;
	const abort = () => { void session?.abort().catch(() => {}); };
	const authorize = (sourceId: string) => {
		cancel.throwIfAborted();
		if (host.getContext() !== context) throw new Error("Knowledge request changed");
		return assertKnowledgeSourceAccess(context.scope, sourceId, host.sourceState());
	};
	try {
		const sources = task.sourceIds.map(authorize);
		research = await createInvestigationReportTools(task.sourceIds, authorize, cancel);
		const names = research.tools.map(tool => tool.name);
		const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", defaultTools: names });
		const cwd = sources[0].root;
		const loader = new DefaultResourceLoader({
			cwd, agentDir: parent.agentDir, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
			systemPrompt: instructions, appendSystemPrompt: [],
		});
		await loader.reload();
		cancel.throwIfAborted();
		({ session } = await createAgentSession({
			cwd, agentDir: parent.agentDir, modelRuntime: parent.modelRuntime, model: parent.model, thinkingLevel: parent.thinkingLevel,
			resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager: settings,
			noTools: "all", tools: names, excludeTools: ["mcp__*"], customTools: research.tools,
		}));
		let turns = 0, calls = 0;
		unsubscribe = session.subscribe(event => {
			if (event.type === "agent_start" && cancel.aborted) abort();
			if (event.type === "turn_start" && ++turns > 16) limit.abort(new Error("Investigation exceeded 16 turns"));
			if (event.type === "tool_execution_start") {
				if (++calls > 32) limit.abort(new Error("Investigation exceeded 32 tool calls"));
				if (event.toolName === "source_report") research?.invalidate();
			}
			if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "length") outputTruncated = true;
		});
		cancel.addEventListener("abort", abort, { once: true });
		cancel.throwIfAborted();
		await session.prompt(JSON.stringify({ task: task.task, sources: sources.map(({ id, kind, name }) => ({ id, kind, name })) }), { expandPromptTemplates: false });
		cancel.throwIfAborted();
		const last = session.messages.at(-1);
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) throw new Error(last.errorMessage || last.stopReason);
		const report = research.getReport();
		if (!report) throw new Error(research.getIssue() || "Investigation ended without a verified source_report");
		task.sourceIds.forEach(authorize);
		return { ...base, status: "completed", ...report, ...research.inspection(), truncated: report.truncated || research.wasTruncated() || outputTruncated };
	} catch (error) {
		const reason = cancel.aborted ? cancel.reason : error;
		const report: InvestigationReport = { findings: [], uncertainties: [String(reason instanceof Error ? reason.message : reason).slice(0, 600)], truncated: outputTruncated || !!research?.wasTruncated() };
		return { ...base, status: signal.aborted ? "cancelled" : "failed", ...report, ...(research?.inspection() ?? { inspectedSourceIds: [], readFailures: [] }) };
	} finally {
		clearTimeout(timer);
		cancel.removeEventListener("abort", abort);
		unsubscribe?.();
		session?.dispose();
	}
}

export function createKnowledgeInvestigateTool(host: KnowledgeToolHost, shutdownSignal: () => AbortSignal): ToolDefinition<typeof parameters> {
	// The SDK serializes sequential tools. The guard also covers direct or nested calls.
	let busy = false;
	return {
		name: "knowledge_investigate", label: "Investigate selected sources", defaultActive: false, exposure: "model-only", executionMode: "sequential",
		annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
		description: "Dispatch up to three independent, read-only source investigations for a complex Ask question. Each task gets only its listed source IDs. Read key lines with source_read yourself before citing a conclusion.",
		parameters,
		execute: async (_id, { tasks }, signal) => {
			const context = host.getContext();
			if (!context || context.mode !== "ask") throw new Error("Investigations require an active Ask request");
			if (busy) throw new Error("Another investigation is running in this conversation");
			if (!tasks.length || tasks.length > 3) throw new Error("Supply 1–3 investigation tasks");
			const cancel = signal ? AbortSignal.any([signal, shutdownSignal()]) : shutdownSignal();
			cancel.throwIfAborted();
			const state = host.sourceState();
			for (const task of tasks) {
				if (!task.task.trim() || !task.sourceIds.length || task.sourceIds.length > 8 || new Set(task.sourceIds).size !== task.sourceIds.length) throw new Error("Each task needs a question and unique selected sources");
				for (const id of task.sourceIds) assertKnowledgeSourceAccess(context.scope, id, state);
			}
			busy = true;
			try {
				const parent = host.parent();
				const results = await Promise.all(tasks.map((task, i) => investigate(task, i + 1, host, context, parent, cancel)));
				const result = { tasks: results };
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			} finally { busy = false; }
		},
	};
}
