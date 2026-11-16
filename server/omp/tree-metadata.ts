/** Read-only structural metadata shared by Bun history and Node tree responses. */
import { stripVTControlCharacters } from "node:util";
import { createHash } from "node:crypto";
import { isRecord } from "./framing.js";
import type { UiTreeSiblings } from "../protocol.js";

export function treeRevision(entries: readonly unknown[], leafId: string | null, sessionId: string) {
	// Native entries are immutable; label changes and rewrites change the ID
	// sequence. Avoid hashing large message/attachment bodies on every refresh.
	return createHash("sha256").update(JSON.stringify([sessionId, leafId, entries.filter(isRecord).map(entry => [entry.id, entry.parentId, entry.type, entry.targetId, entry.label])])).digest("hex");
}

export function treeMetadata(entries: readonly unknown[], leafId: string | null, sessionId: string, displayed: ReadonlySet<string>) {
	const byId = new Map(entries.filter(isRecord).flatMap((entry, rank) => typeof entry.id === "string" ? [[entry.id, { entry, rank }] as const] : []));
	const children = new Map<string | null, string[]>(), labels = new Map<string, string>();
	for (const [id, { entry }] of byId) {
		const parent = typeof entry.parentId === "string" && byId.has(entry.parentId) ? entry.parentId : null;
		const siblings = children.get(parent) ?? []; siblings.push(id); children.set(parent, siblings);
		if (entry.type === "label" && typeof entry.targetId === "string") {
			if (typeof entry.label === "string" && entry.label) labels.set(entry.targetId, stripVTControlCharacters(entry.label).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200)); else labels.delete(entry.targetId);
		}
	}
	const roots = children.get(null) ?? [], order: string[] = [], seen = new Set<string>();
	const displayedGroups = new Map<string | null, string[]>();
	const stack = roots.toReversed().map(id => ({ id, parent: null as string | null }));
	while (stack.length) {
		const { id, parent } = stack.pop()!;
		if (seen.has(id)) continue; seen.add(id); order.push(id);
		let nextParent = parent;
		if (displayed.has(id)) {
			const group = displayedGroups.get(parent) ?? []; group.push(id); displayedGroups.set(parent, group); nextParent = id;
		}
		for (const child of (children.get(id) ?? []).toReversed()) stack.push({ id: child, parent: nextParent });
	}
	// A sibling button restores that branch's latest retained leaf, not its
	// opening user entry (which native navigate_tree would rewind into a draft).
	const tips = new Map<string, { id: string; rank: number }>();
	for (const id of order.toReversed()) {
		const descendants = (children.get(id) ?? []).flatMap(child => tips.has(child) ? [tips.get(child)!] : []);
		let tip = descendants[0] ?? { id, rank: byId.get(id)!.rank };
		for (const next of descendants) if (next.rank > tip.rank) tip = next;
		tips.set(id, tip);
	}
	const siblings = new Map<string, UiTreeSiblings>();
	for (const group of displayedGroups.values()) {
		if (group.length < 2) continue;
		group.sort((a, b) => byId.get(a)!.rank - byId.get(b)!.rank);
		for (let index = 0; index < group.length; index++) siblings.set(group[index], { index: index + 1, count: group.length,
			prevTarget: index > 0 ? tips.get(group[index - 1])?.id : undefined, nextTarget: index + 1 < group.length ? tips.get(group[index + 1])?.id : undefined });
	}
	return { revision: treeRevision(entries, leafId, sessionId), leafId,
		branchPoints: [...children].filter(([parent, values]) => parent !== null && values.length > 1).length,
		rootCount: roots.length, labels, siblings };
}
