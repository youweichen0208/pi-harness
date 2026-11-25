import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { reviewGraphDocument } from "../../server/graph-knowledge-document.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-wiki-proof-"));
	roots.push(root);
	const library = join(root, "wiki"), repo = join(root, "repo");
	mkdirSync(library); mkdirSync(repo);
	const file = "export const answer = 42;\n";
	const sha = createHash("sha256").update(file).digest("hex");
	writeFileSync(join(repo, "a.ts"), file);
	const put = (refs: Record<string, unknown>[]) => {
		const sources = refs.map(ref => Object.entries(ref).map(([key, value], i) =>
			(i === 0 ? "  - " : "    ") + key + ": " + JSON.stringify(value)).join("\n"));
		writeFileSync(join(library, "page.md"), `---\ntitle: demo\nsources:\n${sources.join("\n")}\n---\n# Document\n`);
	};
	const valid = { sourceId: "repository:one", path: "a.ts", lines: "1", sha256: sha, revision: "unknown", workingTree: "modified" };
	const context = { library: (): string | null => library, sources: () => [{ id: valid.sourceId, root: repo }], findNode: async (): Promise<string | undefined> => "node-a" };
	return { root, library, repo, put, valid, context };
}

it("rechecks Learn references with exact content and bounds, and never reveals unregistered source identities", async () => {
	const { put, valid, context } = fixture();
	put([{ session: "session-id" }, valid, { ...valid, sha256: "0".repeat(64) }, { ...valid, lines: "2" },
		{ ...valid, path: "../outside" }, { ...valid, sourceId: "unknown", path: "private.ts" }, { ...valid, sha256: "bad" }]);
	const { references } = await reviewGraphDocument("page.md", context);
	expect(references.map(r => r.state)).toEqual(["verified", "stale", "unverified", "unavailable", "unavailable", "unverified"]);
	expect(references[0]).toMatchObject({ sourceId: valid.sourceId, path: valid.path, line: 1, endLine: 1, nodeId: "node-a" });
	expect(references[4]).toEqual({ state: "unavailable" });
	context.findNode = async () => undefined;
	expect((await reviewGraphDocument("page.md", context)).references[0]).not.toHaveProperty("nodeId");
});

it("reports a real working-tree edit as stale and a deleted target as unavailable", async () => {
	const { repo, put, valid, context } = fixture();
	put([valid]);
	writeFileSync(join(repo, "a.ts"), "export const answer = 11;\n");
	expect((await reviewGraphDocument("page.md", context)).references[0].state).toBe("stale");
	rmSync(join(repo, "a.ts"));
	expect((await reviewGraphDocument("page.md", context)).references[0]).toEqual({ state: "unavailable" });
});

it("drops revoked evidence and rejects a changed library or document during verification", async () => {
	const { put, valid, context, library } = fixture();
	put([valid]);
	const sources = context.sources;
	context.findNode = async () => { context.sources = () => []; return "old-node"; };
	expect((await reviewGraphDocument("page.md", context)).references).toEqual([{ state: "unavailable" }]);
	context.sources = sources;
	context.findNode = async () => { context.library = () => null; return "old-node"; };
	await expect(reviewGraphDocument("page.md", context)).rejects.toThrow("library changed");
	context.library = () => library;
	context.findNode = async () => { put([]); return "old-node"; };
	await expect(reviewGraphDocument("page.md", context)).rejects.toThrow("document changed");
});

it("caps returned sources and reads a regular Markdown file inside the library", async () => {
	const { root, library, valid, put, context } = fixture();
	put(Array(48).fill(valid));
	const result = await reviewGraphDocument("page.md", context);
	expect(result.truncated).toBe(true);
	expect(result.references).toHaveLength(32);
	await expect(reviewGraphDocument("../outside.md", context)).rejects.toThrow("unavailable");
	writeFileSync(join(root, "outside.md"), "# outside");
	if (process.platform !== "win32") {
		symlinkSync(join(root, "outside.md"), join(library, "linked.md"));
		await expect(reviewGraphDocument("linked.md", context)).rejects.toThrow("unavailable");
	}
	put([{ session: "session-only" }]);
	expect((await reviewGraphDocument("page.md", context)).references).toEqual([{ state: "unverified" }]);
});
