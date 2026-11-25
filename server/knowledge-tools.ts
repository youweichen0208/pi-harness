import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { parseSkillBlock, type ExtensionFactory, type InlineExtension, type ToolDefinition, type BeforeAgentStartEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KnowledgeToolHost } from "./knowledge-host.js";
import type { KnowledgeRequestContext, KnowledgeSource, KnowledgeEvidence } from "./knowledge-requests.js";
import { knowledgeToolNames, toolsForKnowledgeMode } from "./knowledge-requests.js";
import { createKnowledgeSourceReader } from "./knowledge-source-reader.js";
import { assertKnowledgeSourceAccess, canonicalSourceRoot, gitFileEvidence } from "./knowledge-sources.js";
import { MAX_KNOWLEDGE_EVIDENCE } from "./knowledge-evidence.js";
import { createKnowledgeInvestigateTool } from "./knowledge-investigate.js";
import { graphTools } from "./knowledge-graph-tools.js";
import { createKnowledgeWriteTool } from "./knowledge-write.js";
import { RUN_CONTINUATION } from "./run-recovery.js";
import { TOOL_TEXT_CONTINUE_PROMPT } from "./tool-text.js";

export const KNOWLEDGE_EXTENSION_PATH = "<inline:pi-harness-knowledge>";
const ORDINARY_TOOL_ENTRY = "pi-harness:knowledge-ordinary-tools";

function eventMode(event: BeforeAgentStartEvent, context: KnowledgeRequestContext | undefined): KnowledgeRequestContext["mode"] | undefined {
	if (!context) return undefined;
	if (event.messageType === "custom") {
		const details = event.message.details as { requestEntryId?: unknown } | undefined;
		return event.message.customType === RUN_CONTINUATION && details?.requestEntryId === context.root ? context.mode : undefined;
	}
	if (event.prompt === TOOL_TEXT_CONTINUE_PROMPT) return context.mode;
	const skill = parseSkillBlock(event.prompt);
	if (!skill || skill.name !== context.mode || skill.location !== context.skillPath) return undefined;
	return context.mode;
}

function withoutKnowledgeTools(tools: string[]): string[] {
	return tools.filter(name => !knowledgeToolNames.includes(name as typeof knowledgeToolNames[number]));
}

export function validKnowledgeTool(pi: Pick<ExtensionAPI, "getAllTools">, name: string): boolean {
	return pi.getAllTools().find(tool => tool.name === name)?.sourceInfo.path === KNOWLEDGE_EXTENSION_PATH;
}

function registerEvidence(host: KnowledgeToolHost, context: KnowledgeRequestContext, source: KnowledgeSource, root: string, input: { path: string; startLine: number; endLine: number; sha256: string }): Promise<string> {
	return gitFileEvidence(root, input.path).then(git => {
		if (host.getContext() !== context) throw new Error("Knowledge request changed while reading evidence");
		const current = assertKnowledgeSourceAccess(context.scope, source.id, host.sourceState());
		if (canonicalSourceRoot(current.root) !== root) throw new Error("Knowledge source root changed");
		const id = `ev_${randomUUID().replaceAll("-", "")}`;
		const evidence: KnowledgeEvidence = {
			id, requestId: context.requestId, conversationId: context.conversationId, requestCwd: context.scope.requestCwd,
			workspaceId: context.scope.workspaceId, scopeSourceIds: [source.id], source, canonicalRoot: root,
			path: input.path, startLine: input.startLine, endLine: input.endLine,
			fingerprint: input.sha256, revision: git.revision, workingTree: git.workingTree,
		};
		host.recordEvidence(evidence);
		context.evidence.set(id, evidence);
		context.evidenceOrder.push(id);
		if (context.evidenceOrder.length > MAX_KNOWLEDGE_EVIDENCE) {
			const stale = context.evidenceOrder.splice(0, context.evidenceOrder.length - MAX_KNOWLEDGE_EVIDENCE);
			for (const key of stale) context.evidence.delete(key);
		}
		return id;
	});
}

function sourceTools(host: KnowledgeToolHost): ToolDefinition[] {
	const readersByRequest = new WeakMap<KnowledgeRequestContext, Map<string, ReturnType<typeof createKnowledgeSourceReader>>>();
	const reader = (context: KnowledgeRequestContext, sourceId: string) => {
		const source = assertKnowledgeSourceAccess(context.scope, sourceId, host.sourceState());
		let readers = readersByRequest.get(context);
		if (!readers) { readers = new Map(); readersByRequest.set(context, readers); }
		let pending = readers.get(sourceId);
		if (!pending) {
			const root = canonicalSourceRoot(source.root);
			pending = createKnowledgeSourceReader(source.root, { evidence: input => registerEvidence(host, context, source, root, input) });
			readers.set(sourceId, pending);
		}
		return pending.then(async value => {
			if (host.getContext() !== context) throw new Error("Knowledge request changed");
			assertKnowledgeSourceAccess(context.scope, sourceId, host.sourceState());
			return value;
		});
	};
	const wrap = (definition: ToolDefinition): ToolDefinition => ({
		...definition,
		defaultActive: false,
		parameters: Type.Object({ ...(definition.parameters as import("typebox").TObject).properties, sourceId: Type.String({ description: "Authorized source ID returned by knowledge_sources." }) }),
		execute: async (id, params, signal, update, ctx) => {
			const context = host.getContext();
			if (!context) throw new Error(`${definition.name} requires an active knowledge request`);
			const sourceId = (params as { sourceId?: unknown }).sourceId;
			if (typeof sourceId !== "string") throw new Error("sourceId is required");
			const selected = await reader(context, sourceId);
			const local = selected.tools.find(tool => tool.name === definition.name);
			if (!local) throw new Error("Source reader is unavailable");
			const { sourceId: _sourceId, ...args } = params as Record<string, unknown>;
			const result = await local.execute(id, args as never, signal, update, ctx);
			signal?.throwIfAborted();
			if (host.getContext() !== context) throw new Error("Knowledge request changed");
			assertKnowledgeSourceAccess(context.scope, sourceId, host.sourceState());
			return result;
		},
	});
	const sources: ToolDefinition = {
		name: "knowledge_sources", label: "List authorized knowledge sources", defaultActive: false,
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		description: "List only sources authorized for this request. Use these IDs for every source_list, source_search or source_read call.",
		parameters: Type.Object({}),
		execute: async () => {
			const context = host.getContext();
			if (!context) throw new Error("knowledge_sources requires an active knowledge request");
			const state = host.sourceState();
			const sources = context.scope.sources.map(source => assertKnowledgeSourceAccess(context.scope, source.id, state));
			return { content: [{ type: "text", text: JSON.stringify({ workspaceId: context.scope.workspaceId, sources }, null, 2) }], details: {} };
		},
	};
	const relativePath = Type.String({ minLength: 1, maxLength: 2048 });
	const definitions: ToolDefinition[] = [
		{
			name: "source_list", label: "List source", defaultActive: false,
			description: "List immediate files/directories in an authorized source. Requires sourceId from knowledge_sources.",
			parameters: Type.Object({ path: Type.Optional(relativePath), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
			execute: async () => { throw new Error("Source reader was not initialized"); },
		},
		{
			name: "source_search", label: "Search source", defaultActive: false,
			description: "Search a literal substring in an authorized source. Requires sourceId. Hits include server evidence IDs only for complete observed lines.",
			parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 256 }), path: Type.Optional(relativePath), caseSensitive: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
			execute: async () => { throw new Error("Source reader was not initialized"); },
		},
		{
			name: "source_read", label: "Read source", defaultActive: false,
			description: "Read original lines in an authorized source. Requires sourceId. Returns a server evidenceId and full-file SHA-256 for clickable evidence links.",
			parameters: Type.Object({ path: relativePath, startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }),
			execute: async () => { throw new Error("Source reader was not initialized"); },
		},
	];
	return [sources, ...definitions.map(wrap)];
}

export function knowledgeExtension(host: KnowledgeToolHost): InlineExtension {
	const factory: ExtensionFactory = pi => {
		let ordinaryTools: string[] | undefined;
		let authorized: KnowledgeRequestContext | undefined;
		let shutdown = new AbortController();
		const restoreOrdinaryTools = (ctx: ExtensionContext) => {
			const active = pi.getActiveTools(), clean = withoutKnowledgeTools(active);
			if (ordinaryTools) pi.setActiveTools(ordinaryTools);
			else if (clean.length !== active.length) {
				const marker = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === ORDINARY_TOOL_ENTRY);
				const saved = marker?.type === "custom" ? marker.data : undefined;
				const names = Array.isArray(saved) && saved.every(name => typeof name === "string") ? withoutKnowledgeTools(saved) : [];
				pi.setActiveTools([...new Set([...names, ...clean])]);
			}
			ordinaryTools = undefined;
			authorized = undefined;
		};
		for (const tool of [...sourceTools(host), ...graphTools(host), createKnowledgeWriteTool(host), createKnowledgeInvestigateTool(host, () => shutdown.signal)]) pi.registerTool(tool);
		pi.on("before_agent_start", (event, ctx) => {
			const context = host.getContext(), mode = eventMode(event, context);
			const options = event.systemPromptOptions;
			authorized = undefined;
			if (!context) {
				options.selectedTools = withoutKnowledgeTools(options.selectedTools);
				delete options.sections.knowledge_request;
				return;
			}
			ordinaryTools = withoutKnowledgeTools(options.selectedTools);
			pi.appendEntry(ORDINARY_TOOL_ENTRY, ordinaryTools);
			const allowed = mode ? toolsForKnowledgeMode(mode, context.graphQuery) : [];
			if (!mode || !allowed.every(name => validKnowledgeTool(pi, name))) {
				// Pi reports errors thrown by hooks and continues preparing the run.
				// Clear executable tools before cancelling a failed identity check.
				options.selectedTools = [];
				pi.setActiveTools([]);
				ctx.abort();
				throw new Error("Knowledge request or registered tool identity changed");
			}
			authorized = context;
			options.selectedTools = [...allowed];
			options.sections.knowledge_request = JSON.stringify({
				mode, requestId: context.requestId,
				sources: context.scope.sources.map(({ id, kind, name }) => ({ id, kind, name })),
				citation: "Use Markdown links like [repository/path:line](#pi-evidence=<evidenceId>) only for evidence IDs returned by source tools.",
			});
		});
		pi.on("tool_call", event => {
			const context = host.getContext(), allowed = context ? toolsForKnowledgeMode(context.mode, context.graphQuery) : [];
			if (knowledgeToolNames.includes(event.toolName as typeof knowledgeToolNames[number])) {
				if (!context || authorized !== context || !allowed.includes(event.toolName) || !validKnowledgeTool(pi, event.toolName)) return { block: true, reason: "Knowledge tool is not authorized for this request" };
				return;
			}
			if (context) return { block: true, reason: `${event.toolName} is not available in ${context.mode} mode` };
		});
		pi.on("agent_settled", (_event, ctx) => { if (ordinaryTools) restoreOrdinaryTools(ctx); });
		pi.on("session_tree", (_event, ctx) => restoreOrdinaryTools(ctx));
		pi.on("session_start", (_event, ctx) => { shutdown = new AbortController(); restoreOrdinaryTools(ctx); });
		pi.on("session_shutdown", () => shutdown.abort());
	};
	return { name: "pi-harness-knowledge", replaceable: false, factory };
}

export { eventMode };
