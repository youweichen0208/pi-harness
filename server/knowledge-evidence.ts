import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FileEvidenceView } from "./protocol.js";
import type { KnowledgeEvidence } from "./knowledge-requests.js";

export const KNOWLEDGE_EVIDENCE_ENTRY = "pi-harness:knowledge-evidence";
export const MAX_KNOWLEDGE_EVIDENCE = 256;
type EvidenceSession = Pick<SessionManager, "getLeafEntry" | "getEntry" | "getSessionId">;
const branchLookups = new WeakMap<EvidenceSession, {
	leaf: ReturnType<EvidenceSession["getLeafEntry"]>;
	found: Map<string, KnowledgeEvidence>;
}>();

/** The native session and its selected branch own citations across reloads.
 * Browser conversation IDs are allocated afresh when history is reopened. */
export function branchEvidence(manager: EvidenceSession, conversationId: string, id: string): KnowledgeEvidence | undefined {
	if (!/^ev_[a-f0-9]{32}$/.test(id)) return;
	const leaf = manager.getLeafEntry();
	let cache = branchLookups.get(manager);
	if (!cache || cache.leaf !== leaf) {
		cache = { leaf, found: new Map() };
		branchLookups.set(manager, cache);
	}
	const hit = cache.found.get(id);
	if (hit) return { ...hit, conversationId };
	for (let entry = leaf; entry; entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined) {
		if (entry.type !== "custom" || entry.customType !== KNOWLEDGE_EVIDENCE_ENTRY) continue;
		const record = entry.data as { sessionId?: string; evidence?: KnowledgeEvidence } | undefined;
		if (record?.sessionId === manager.getSessionId() && record.evidence?.id === id) {
			if (cache.found.size === MAX_KNOWLEDGE_EVIDENCE) cache.found.delete(cache.found.keys().next().value!);
			cache.found.set(id, record.evidence);
			return { ...record.evidence, conversationId };
		}
	}
}

export function evidenceView(evidence: KnowledgeEvidence): FileEvidenceView {
	const { id, requestId, conversationId, source, path, startLine, endLine, fingerprint, revision, workingTree } = evidence;
	return { id, requestId, conversationId, sourceId: source.id, sourceName: source.name, sourceKind: source.kind, path, startLine, endLine, fingerprint, revision, workingTree };
}

/** A long line next to the citation must not turn a small preview into a large
 * response. Evidence is issued only for complete, bounded lines. */
export function evidenceWindow(lines: string[], targetLine: number) {
	const limit = 64 * 1024;
	let start = targetLine - 1, end = targetLine;
	let bytes = Buffer.byteLength(lines[start]);
	while (start > 0 && targetLine - start <= 40) {
		const cost = Buffer.byteLength(lines[start - 1]) + 1;
		if (bytes + cost > limit) break;
		start--; bytes += cost;
	}
	while (end < lines.length && end - start < 120) {
		const cost = Buffer.byteLength(lines[end]) + 1;
		if (bytes + cost > limit) break;
		end++; bytes += cost;
	}
	return { startLine: start + 1, lines: end - start, text: lines.slice(start, end).join("\n"), truncated: start > 0 || end < lines.length };
}
