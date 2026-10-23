import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeLibrary } from "../../server/knowledge-library.js";

test("library configuration survives restart, validates folders, and ignores old-window updates", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "knowledge-config-")));
	try {
		const first = join(base, "first"), second = join(base, "second"), data = join(base, "data");
		mkdirSync(first); mkdirSync(second); writeFileSync(join(first, "a.md"), "# A");
		const library = new KnowledgeLibrary(data);
		expect(library.read().cwd).toBeNull();
		expect(() => library.configure(join(first, "a.md"))).toThrow();
		expect(() => library.configure("relative")).toThrow();
		library.configure(first); library.remember(first, "a.md");
		expect(new KnowledgeLibrary(data).read()).toEqual({ cwd: first, path: "a.md", available: true });
		library.configure(second); library.remember(first, "a.md");
		expect(library.read()).toEqual({ cwd: second, path: null, available: true });
		rmSync(second, { recursive: true }); expect(library.read().available).toBe(false);
		expect(library.read().cwd).toBe(second);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("remembered documents cannot escape the library or retain deleted files", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "knowledge-paths-")));
	try {
		const root = join(base, "root"); mkdirSync(root); writeFileSync(join(base, "outside.md"), "outside");
		const library = new KnowledgeLibrary(join(base, "data")); library.configure(root);
		expect(library.remember(root, "../outside.md").path).toBeNull();
		if (process.platform !== "win32") { symlinkSync(join(base, "outside.md"), join(root, "link.md")); expect(library.remember(root, "link.md").path).toBeNull(); }
		writeFileSync(join(root, "a.md"), "A"); library.remember(root, "a.md"); rmSync(join(root, "a.md"));
		expect(library.read().path).toBeNull();
	} finally { rmSync(base, { recursive: true, force: true }); }
});
