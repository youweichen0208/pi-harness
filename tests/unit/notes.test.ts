import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NotesStore } from "../../server/notes.js";
const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "pi-notes-")); roots.push(root); return { root, store: new NotesStore(join(root, "notes")) }; }
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
it("persists global notes, searches bodies and sorts pins before recent notes", () => {
	const { root, store } = fixture();
	const a = store.create({ title: "", body: "- [ ] 中文", pinned: true });
	const b = store.create({ title: "Other", body: "searchable", pinned: false });
	const reopened = new NotesStore(join(root, "notes"));
	expect(reopened.list().map(note => note.id)).toEqual([a.id, b.id]);
	expect(reopened.list("SEARCHABLE")).toEqual([b]);
	const updated = reopened.update(a.id, a.version, { ...a, body: "- [x] 中文" });
	expect(updated.version).toBe(2);
	expect(store.read(a.id).body).toBe("- [x] 中文");
	store.delete(b.id, b.version);
	expect(reopened.list()).toEqual([updated]);
});
it("rejects concurrent stale writes and deletes without losing content", () => {
	const { store } = fixture();
	const a = store.create({ title: "original", body: "", pinned: false });
	const updated = store.update(a.id, 1, { ...a, title: "winner" });
	expect(() => store.update(a.id, 1, { ...a, title: "stale" })).toThrow(/another window/);
	expect(() => store.delete(a.id, 1)).toThrow(/another window/);
	expect(store.read(a.id)).toEqual(updated);
	expect(() => store.update(a.id, NaN, a)).toThrow();
	expect(() => store.read("../../secret")).toThrow();
});
it("retains corrupt evidence and does not acknowledge failed writes", () => {
	const { store, root } = fixture();
	const note = store.create({ title: "a", body: "b", pinned: false });
	const path = join(root, "notes", `${note.id}.json`);
	writeFileSync(path, "broken");
	expect(() => store.update(note.id, 1, note)).toThrow();
	expect(readFileSync(path, "utf8")).toBe("broken");
	rmSync(join(root, "notes"), { recursive: true });
	writeFileSync(join(root, "notes"), "blocked");
	expect(() => store.create(note)).toThrow();
	rmSync(join(root, "notes")); mkdirSync(join(root, "notes"));
	expect(store.list()).toEqual([]);
});
