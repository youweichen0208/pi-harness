import type { PromptAttachment } from "./protocol.js";

export type KnowledgeMode = "ask" | "learn";

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
export const knowledgeToolNames = [...knowledgeReadToolNames, "knowledge_write", "knowledge_investigate"] as const;

export function toolsForKnowledgeMode(mode: KnowledgeMode): readonly string[] {
	switch (mode) {
		case "learn": return [...knowledgeReadToolNames, "knowledge_write"];
		case "ask": return [...knowledgeReadToolNames, "knowledge_investigate"];
	}
}

export function parseKnowledgeCommand(text: string): { mode: KnowledgeMode; normalizedText: string; args: string } | null {
	const match = /^\/(?:skill:)?(learn|ask)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return null;
	const mode = match[1] as KnowledgeMode, args = match[2] ?? "";
	return { mode, normalizedText: `/skill:${mode}${args ? ` ${args}` : ""}`, args };
}

export function emptyKnowledgeState(): KnowledgeConversationState {
	return { pending: [], evidence: new Map(), evidenceOrder: [], nativeSteering: [], nativeFollowUp: [], draining: false };
}
