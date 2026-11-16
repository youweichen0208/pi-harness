/** Bun-only read-only projection using OMP's public session-tree selector. */
import { collectEntriesForBranchSummary } from "@oh-my-pi/pi-agent-core/compaction";
import { SessionEntryIndex } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isRecord } from "./framing.js";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { treeRevision } from "./tree-metadata.js";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { TREE_FILTER_MODES, TreeSelectorComponent } from "@oh-my-pi/pi-tui/overlays/tree-selector";

export function nativeTree(manager: Pick<SessionManager, "getEntries" | "getTree" | "getLeafId" | "getSessionId">, filter: unknown = "default", query: unknown = "", previewTarget?: string) {
	if (!TREE_FILTER_MODES.some(mode => mode === filter) || typeof query !== "string") throw Error("Invalid tree filter");
	const mode = TREE_FILTER_MODES.find(mode => mode === filter)!;
	const entries = manager.getEntries(), leafId = manager.getLeafId();
	let preview: { entryCount: number; commonAncestorId: string | null } | undefined;
	if (previewTarget !== undefined) {
		const index = new SessionEntryIndex(); index.rebuild(entries);
		if (!index.has(previewTarget)) throw Error("Unknown tree entry");
		const collected = collectEntriesForBranchSummary({ getEntry: id => index.get(id), getBranch: id => index.pathTo(id ?? leafId) }, leafId, previewTarget);
		preview = { entryCount: collected.entries.length, commonAncestorId: collected.commonAncestorId };
	}
	// The public picker data owns sorting, fuzzy search, native entry kinds and
	// hidden-assistant rules. Never route activation/label callbacks to a session.
	const selector = new TreeSelectorComponent(manager.getTree(), leafId, 30, () => {}, () => {}, undefined, mode === "all" ? "default" : "all");
	try {
		const list = selector.getTreeList();
		// Assign text directly: a query containing terminal escape sequences must
		// not be interpreted as selection, label editing or another UI command.
		list.searchInput.setValue(query.slice(0, 1000));
		list.setFilterMode(mode);
		const view = list.pickerView();
		return { entries, leafId, preview, revision: treeRevision(entries, leafId, manager.getSessionId()), order: view.order.slice(0, 5000), truncated: view.order.length > 5000,
			items: view.items.map(item => ({ id: item.id, depth: item.depth ?? 0, node: item.node,
				preview: (typeof item.label === "string" ? item.label : item.label.map(span => span.t).join("")).slice(0, 300),
				label: item.badges?.[0]?.text, onActivePath: item.dot === "accent" })) };
	} finally { selector.dispose(); }
}

/** Public native loader/index provide a read-only manager view. No sessions,
 * extensions, credentials or models are initialized by this path. */
export async function savedNativeTree(file: string, query: { filter: string; query: string; previewTarget?: string; leafId?: string | null; sessionId?: string }) {
	const { loadSessionFile } = await import("@oh-my-pi/pi-coding-agent/session/session-loader");
	const { SessionEntryIndex } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
	const { stat } = await import("node:fs/promises");
	const stamp = (value: Awaited<ReturnType<typeof stat>>) => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(":");
	const before = stamp(await stat(file)), loaded = await loadSessionFile(file, undefined, { throwIfMissing: true });
	const header = loaded.entries[0];
	if (loaded.invalidHeader || loaded.malformedRecords || !header || header.type !== "session" || stamp(await stat(file)) !== before || query.sessionId && header.id !== query.sessionId) throw Error("Saved tree changed or is invalid");
	const entries = loaded.entries.filter(entry => entry.type !== "session");
	if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw Error("Duplicate native tree entry");
	const index = new SessionEntryIndex(); index.rebuild(entries);
	const leafId = query.leafId === undefined ? index.leafEntry()?.id ?? null : query.leafId;
	if (leafId !== null && !index.has(leafId)) throw Error("Saved tree no longer contains the selected leaf");
	return nativeTree({ getEntries: () => entries, getTree: () => index.tree(entries), getLeafId: () => leafId, getSessionId: () => header.id }, query.filter, query.query, query.previewTarget);
}

export async function memoryNativeTree(snapshot: unknown, query: { filter: string; query: string; previewTarget?: string }) {
	if (!isRecord(snapshot) || !Array.isArray(snapshot.entries) || typeof snapshot.sessionId !== "string" || !(snapshot.leafId === null || typeof snapshot.leafId === "string")) throw Error("Invalid native tree snapshot");
	if (!snapshot.entries.every(entry => isRecord(entry) && typeof entry.id === "string" && typeof entry.type === "string" && (entry.parentId === null || typeof entry.parentId === "string"))) throw Error("Invalid native tree entries");
	const entries = snapshot.entries as SessionEntry[];
	if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw Error("Duplicate native tree entry");
	const { SessionEntryIndex } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
	const index = new SessionEntryIndex(); index.rebuild(entries);
	const leafId = snapshot.leafId, sessionId = snapshot.sessionId;
	if (leafId !== null && !index.has(leafId)) throw Error("Unknown native tree leaf");
	return nativeTree({ getEntries: () => entries, getTree: () => index.tree(entries), getLeafId: () => leafId, getSessionId: () => sessionId }, query.filter, query.query, query.previewTarget);
}
