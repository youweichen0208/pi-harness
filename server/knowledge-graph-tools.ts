import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseGraphRequest } from "./workspace-graph-query.js";
import type { WorkspaceGraphResult } from "./protocol.js";
import type { KnowledgeToolHost } from "./knowledge-host.js";
import { toolsForKnowledgeMode, type KnowledgeRequestContext } from "./knowledge-requests.js";
import { assertKnowledgeSourceAccess, resolveWorkspaceScope } from "./knowledge-sources.js";

const text = Type.String({ minLength: 1, maxLength: 512 });
const empty = Type.Object({}, { additionalProperties: false });
const definitions = [
	["graph_status", "Read the state and last published version of the authorized Workspace graph.", empty],
	["graph_build", "Start a full build of the entire authorized Workspace graph.", empty],
	["graph_update", "Update the existing Workspace graph from changes to repository sources.", empty],
	["graph_search", "Find graph nodes by a short name or symbol. Read original source lines to verify any lead.", Type.Object({ query: text, sourceId: Type.Optional(text) }, { additionalProperties: false })],
	["graph_neighbors", "List adjacent nodes for a returned node ID. Set impact=true to follow dependent importers and downstream event consumers.", Type.Object({ nodeId: text, impact: Type.Optional(Type.Boolean()) }, { additionalProperties: false })],
	["graph_path", "Find a structural path between two returned node IDs in the authorized sources.", Type.Object({ from: text, to: text }, { additionalProperties: false })],
] as const;

function scopeFor(host: KnowledgeToolHost, context: KnowledgeRequestContext, write: boolean) {
	const { scope } = context;
	if (!scope.workspaceId) throw Error("Select a project Workspace to use its graph. For Ask, use source_search and source_read.");
	const state = host.sourceState();
	const current = resolveWorkspaceScope({ cwd: scope.requestCwd, workspaceId: scope.workspaceId }, state);
	if (current.issue) throw Error("Workspace registration has changed");
	const ids = scope.sources.filter(source => source.kind === "repository").map(source => assertKnowledgeSourceAccess(scope, source.id, state).id);
	if (!ids.length) throw Error("No authorized graph repository");
	if (write && current.scope.sources.some(source => source.kind === "repository" && !ids.includes(source.id))) {
		throw Error("Building or updating a graph requires the entire Workspace. The requested source restriction prevents this operation.");
	}
	return { id: scope.workspaceId, ids };
}

function boundedResult(result: WorkspaceGraphResult) {
	// Return whole entries and valid JSON even when a Workspace has many sources.
	const summary: WorkspaceGraphResult = {
		workspaceId: result.workspaceId, state: result.state, version: result.version, publishedAt: result.publishedAt,
		error: result.error?.slice(0, 600), truncated: result.truncated, nodes: [], edges: [], sources: [],
	};
	let bytes = Buffer.byteLength(JSON.stringify(summary)) + 32;
	const append = <T>(items: readonly T[], to: T[]) => {
		for (const item of items) {
			const size = Buffer.byteLength(JSON.stringify(item)) + 1;
			if (bytes + size > 24 * 1024) { summary.truncated = true; break; }
			to.push(item);
			bytes += size;
		}
	};
	append(result.nodes, summary.nodes);
	append(result.edges, summary.edges);
	append(result.sources, summary.sources);
	return JSON.stringify(summary);
}

export function graphTools(host: KnowledgeToolHost): ToolDefinition[] {
	return definitions.map(([op, description, parameters]): ToolDefinition => {
		const write = op === "graph_build" || op === "graph_update";
		return {
			name: op, label: op.replaceAll("_", " "), parameters, description, defaultActive: false, exposure: "model-only",
			annotations: { readOnlyHint: !write, openWorldHint: false, destructiveHint: false },
			execute: async (_id, params, signal) => {
				const context = host.getContext();
				if (!context || !toolsForKnowledgeMode(context.mode, context.graphQuery).includes(op)) throw Error("Graph action is not authorized for this request");
				if (!host.graph) throw Error("Workspace graph service is unavailable");
				signal?.throwIfAborted();
				const scope = scopeFor(host, context, write);
				const impact = op === "graph_neighbors" && params && typeof params === "object" && "impact" in params && params.impact === true;
				const request = parseGraphRequest(Object.assign({}, params, { op: impact ? "graph_impact" : op }));
				if (request.op === "graph_search" && request.sourceId && !scope.ids.includes(request.sourceId)) throw Error("Graph source is outside the request scope");
				const result = await host.graph.execute(scope.id, request, scope.ids);
				signal?.throwIfAborted();
				if (host.getContext() !== context) throw Error("The active graph request changed");
				scopeFor(host, context, write);
				return { content: [{ type: "text", text: boundedResult(result) }], details: {} };
			},
		};
	});
}
