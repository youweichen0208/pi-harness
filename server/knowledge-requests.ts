import type { PromptAttachment } from "./protocol.js";

export type KnowledgeMode = "ask" | "learn" | "build-graph" | "update-graph";
export function isGraphMaintenance(mode?: KnowledgeMode): boolean {
	return mode === "build-graph" || mode === "update-graph";
}

export type KnowledgeSourceKind = "repository" | "knowledge";

export interface KnowledgeSource {
	id: string;
	kind: KnowledgeSourceKind;
	name: string;
	root: string;
}

export interface KnowledgeScope {
	requestCwd: string;
	workspaceId?: string;
	workspaceSourceIds: string[];
	sourceIds: string[];
	sources: KnowledgeSource[];
}

export interface KnowledgeEvidence {
	id: string;
	requestId: string;
	conversationId: string;
	requestCwd: string;
	workspaceId?: string;
	scopeSourceIds: string[];
	source: KnowledgeSource;
	path: string;
	startLine: number;
	endLine: number;
	fingerprint: string;
	/** Canonical root at issuance, including when the registered path is an alias. */
	canonicalRoot?: string;
	revision?: string;
	workingTree: "clean" | "modified" | "untracked" | "unknown";
}

export interface KnowledgeRequestContext {
	mode: KnowledgeMode;
	graphQuery?: boolean;
	requestId: string;
	conversationId: string;
	sessionId: string;
	root: string;
	rawCommand: string;
	skillPath: string;
	scope: KnowledgeScope;
	evidence: Map<string, KnowledgeEvidence>;
	evidenceOrder: string[];
}

export interface DeferredKnowledgePrompt {
	graphWorkspaceId?: string;
	text: string;
	normalizedText: string;
	attachments?: PromptAttachment[];
	queue: boolean;
	requestId?: string;
}

export interface KnowledgeConversationState {
	active?: KnowledgeRequestContext;
	pending: DeferredKnowledgePrompt[];
	evidence: Map<string, KnowledgeEvidence>;
	evidenceOrder: string[];
	nativeSteering: string[];
	nativeFollowUp: string[];
	draining: boolean;
}

export const knowledgeReadToolNames = ["knowledge_sources", "source_list", "source_search", "source_read"] as const;
export const graphReadTools = ["graph_status", "graph_search", "graph_neighbors", "graph_path"] as const;
export const knowledgeToolNames = [...knowledgeReadToolNames, "knowledge_write", "knowledge_investigate", ...graphReadTools, "graph_build", "graph_update"] as const;

export function toolsForKnowledgeMode(mode: KnowledgeMode, graphQuery = false): readonly string[] {
	switch (mode) {
		case "learn": return [...knowledgeReadToolNames, "knowledge_write"];
		case "ask": return [...knowledgeReadToolNames, "knowledge_investigate", ...(graphQuery ? graphReadTools : [])];
		case "build-graph": return ["graph_status", "graph_build"];
		case "update-graph": return ["graph_status", "graph_update"];
	}
}

export function parseKnowledgeCommand(text: string): { mode: KnowledgeMode; normalizedText: string; args: string } | null {
	const match = /^\/(?:skill:)?(learn|ask|build-graph|update-graph)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return null;
	const mode = match[1] as KnowledgeMode, args = match[2] ?? "";
	return { mode, normalizedText: `/skill:${mode}${args ? ` ${args}` : ""}`, args };
}

export function emptyKnowledgeState(): KnowledgeConversationState {
	return { pending: [], evidence: new Map(), evidenceOrder: [], nativeSteering: [], nativeFollowUp: [], draining: false };
}
