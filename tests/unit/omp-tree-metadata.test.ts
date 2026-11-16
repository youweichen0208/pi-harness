import { expect, it } from "vitest";
import { treeMetadata, treeRevision } from "../../server/omp/tree-metadata.js";
import { projectMessage } from "../../server/omp/presentation.js";

it("projects stable sibling choices through hidden metadata to retained branch tips", () => {
	const entries = [
		{ id: "root", parentId: null, type: "custom" },
		{ id: "old", parentId: "root", type: "message" },
		{ id: "reply", parentId: "old", type: "message" },
		{ id: "meta", parentId: "root", type: "model_change" },
		{ id: "new", parentId: "meta", type: "message" },
		{ id: "new-reply", parentId: "new", type: "message" },
		{ id: "label", parentId: "new-reply", type: "label", targetId: "new", label: "Bookmark" },
	];
	const original = structuredClone(entries);
	const displayed = new Set(["old", "reply", "new", "new-reply"]);
	const state = treeMetadata(entries, "label", "session", displayed);
	expect(state).toMatchObject({ leafId: "label", rootCount: 1, branchPoints: 1 });
	expect(state.labels.get("new")).toBe("Bookmark");
	expect(state.siblings.get("old")).toEqual({ index: 1, count: 2, prevTarget: undefined, nextTarget: "label" });
	expect(state.siblings.get("new")).toEqual({ index: 2, count: 2, prevTarget: "reply", nextTarget: undefined });
	expect(state.siblings.has("reply")).toBe(false);
	const switched = treeMetadata(entries, "reply", "session", displayed);
	expect(switched.siblings).toEqual(state.siblings);
	expect(switched.revision).not.toBe(state.revision);
	expect(treeRevision(entries, "label", "other-session")).not.toBe(state.revision);
	expect(entries).toEqual(original);
	const cleared = treeMetadata([...entries, { id: "clear", parentId: "label", type: "label", targetId: "new", label: undefined }], "clear", "session", displayed);
	expect(cleared.labels.has("new")).toBe(false); expect(cleared.revision).not.toBe(state.revision);
});

it("handles multiple roots, orphaned chains, nested branches and long paths without recursion", () => {
	const entries = [{ id: "a", parentId: null }, { id: "b", parentId: "absent" }, { id: "b1", parentId: "b" }, { id: "b2", parentId: "b" }];
	const result = treeMetadata(entries, "b2", "s", new Set(entries.map(entry => entry.id)));
	expect(result).toMatchObject({ rootCount: 2, branchPoints: 1 });
	expect(result.siblings.get("a")?.nextTarget).toBe("b2");
	expect(result.siblings.get("b2")?.prevTarget).toBe("b1");
	const long = Array.from({ length: 10000 }, (_, i) => ({ id: `e${i}`, parentId: i ? `e${i - 1}` : null }));
	expect(treeMetadata(long, "e9999", "long", new Set(long.map(entry => entry.id)))).toMatchObject({ rootCount: 1, branchPoints: 0 });
});

it("retains native summary entry identity for bookmarks and tree navigation", () => {
	for (const role of ["compactionSummary", "branchSummary"]) expect(projectMessage({ role, summary: "summary", timestamp: 1 }, 0, "native-id")).toMatchObject({ role, entryId: "native-id" });
});
