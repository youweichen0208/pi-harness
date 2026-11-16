import type { TreeFilterMode, UiTreeNode } from "../protocol.js";
import { isRecord } from "./framing.js";
import { projectMessage } from "./presentation.js";
import type { OmpSession } from "./session.js";
import { nativeEntryMessage } from "./native-messages.js";

export async function readTree(session: OmpSession, filter: TreeFilterMode = "default", query = "", previewTarget?: string) {
	if (!["default", "no-tools", "user-only", "labeled-only", "all"].includes(filter) || typeof query !== "string") throw Error("Invalid tree filter");
	query = query.slice(0, 1000);
	const response = await session.treeData(filter, query, previewTarget);
	if (!isRecord(response.data) || !Array.isArray(response.data.entries) || !Array.isArray(response.data.items) || !Array.isArray(response.data.order) || typeof response.data.revision !== "string") throw Error("Invalid native tree response");
	const rawPreview = response.data.preview;
	const preview = isRecord(rawPreview) && Number.isInteger(rawPreview.entryCount) && typeof rawPreview.entryCount === "number" && rawPreview.entryCount >= 0 && (rawPreview.commonAncestorId === null || typeof rawPreview.commonAncestorId === "string")
		? { entryCount: rawPreview.entryCount, commonAncestorId: rawPreview.commonAncestorId } : undefined;
	const entries = response.data.entries.filter(isRecord);
	const byId = new Map(entries.flatMap(entry => typeof entry.id === "string" ? [[entry.id, entry] as const] : []));
	const leafId = typeof response.data.leafId === "string" ? response.data.leafId : null;
	const items = response.data.items.filter(isRecord);
	const visibleIds = new Set(response.data.order.filter((id): id is string => typeof id === "string"));
	const children = new Map<string, number>();
	for (const entry of entries) if (typeof entry.parentId === "string" && byId.has(entry.parentId)) children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
	const nodes = new Map<string, UiTreeNode>(), ancestry = new Map<string, { root: string; visible: string | null }>();
	// Native items are in structural preorder, including filtered ancestors.
	for (const item of items) {
		if (typeof item.id !== "string") continue;
		const id = item.id, entry = byId.get(id); if (!entry) continue;
		const parentId = typeof entry.parentId === "string" ? entry.parentId : null, parent = parentId ? ancestry.get(parentId) : undefined;
		const root = parent?.root ?? id;
		ancestry.set(id, { root, visible: visibleIds.has(id) ? id : parent?.visible ?? null });
		if (!visibleIds.has(id)) continue;
		const message = projectMessage(nativeEntryMessage(entry), 0, id);
		const kind: UiTreeNode["kind"] = item.node === "user" ? "user" : item.node === "assistant" ? "assistant" : item.node === "tool" ? "tool" : entry.type === "compaction" ? "compaction" : entry.type === "branch_summary" ? "branchSummary" : entry.type === "model_change" || entry.type === "model_usage" ? "model" : entry.type === "thinking_level_change" ? "thinking" : entry.type === "label" ? "label" : "custom";
		const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : typeof entry.timestamp === "number" ? entry.timestamp : 0;
		nodes.set(id, { id, parentId, visibleParentId: parent?.visible ?? null, depth: typeof item.depth === "number" ? item.depth : 0, rootId: root, kind,
			preview: typeof item.preview === "string" ? item.preview : "", timestamp: Number.isFinite(timestamp) ? timestamp : 0,
			label: typeof item.label === "string" ? item.label : undefined, onActivePath: item.onActivePath === true, isLeaf: !children.has(id), childCount: children.get(id) ?? 0,
			toolName: message?.toolName, model: typeof entry.model === "string" ? entry.model : isRecord(entry.message) && typeof entry.message.model === "string" ? entry.message.model : undefined,
			stopReason: message?.stopReason === "error" || message?.stopReason === "aborted" ? message.stopReason : undefined,
			summaryFromId: entry.type === "branch_summary" && typeof entry.fromId === "string" ? entry.fromId : undefined });
	}
	return { byId, leafId, preview, nodes: [...visibleIds].flatMap(id => { const node = nodes.get(id); return node ? [node] : []; }), truncated: response.data.truncated === true, revision: response.data.revision };
}
