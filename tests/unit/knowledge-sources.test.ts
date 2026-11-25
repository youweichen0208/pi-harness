import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeSourceReader } from "../../server/knowledge-source-reader.js";
import { KnowledgeScopeError, assertKnowledgeEvidenceAccess, assertKnowledgeSourceAccess, resolveRequestScope, resolveWorkspaceScope } from "../../server/knowledge-sources.js";
import type { KnowledgeEvidence } from "../../server/knowledge-requests.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "knowledge-sources-")); roots.push(root);
	const repoA = join(root, "repo-a"), repoB = join(root, "repo-b"), library = join(root, "library");
	for (const path of [repoA, repoB, library]) mkdirSync(path, { recursive: true });
	const state = {
		catalog: { revision: 0, workspaces: [{ id: "one", name: "One", paths: [repoA, repoB] }] },
		library: { cwd: library, path: null, available: true },
	};
	const workspace = resolveWorkspaceScope({ cwd: repoA }, state);
	return { root, repoA, repoB, library, state, workspace };
}
const execute = (tool: any, params: Record<string, unknown>) => tool.execute("test", params, undefined, undefined, undefined);

describe("knowledge source scopes", () => {
	it("resolves one Workspace and applies include/exclude subsets before reading", () => {
		const { repoA, repoB, library, state, workspace } = fixture();
		expect(workspace.issue).toBeUndefined();
		expect(workspace.scope.sources.map(source => source.kind)).toEqual(["repository", "repository", "knowledge"]);
		const scoped = resolveRequestScope("只查看 repo-a 和数据库知识库，分析当前实现", workspace.scope);
		expect(scoped.sources.map(source => source.root)).toEqual([repoA, library]);
		expect(resolveRequestScope("请只查 repo-a，回答问题", workspace.scope).sources.map(source => source.root)).toEqual([repoA]);
		const excluded = resolveRequestScope("不要读取 repo-b", workspace.scope);
		expect(excluded.sources.map(source => source.root)).toEqual([repoA, library]);
		expect(() => resolveRequestScope("只查看 missing-repo", workspace.scope)).toThrow(/无法确定/);
		expect(() => resolveRequestScope("不要读取 repo-a、repo-b 和知识库", workspace.scope)).toThrow(/来源为空/);
		const removed = { ...state, catalog: { revision: 1, workspaces: [] } };
		const sourceId = workspace.scope.sources[0].id;
		expect(() => assertKnowledgeSourceAccess(workspace.scope, sourceId, removed)).toThrow(/不再属于|失效/);
		const other = resolveWorkspaceScope({ cwd: repoB }, state).scope;
		expect(other.workspaceId).toBe("one");
	});

	it("requires Workspace and duplicate-source disambiguation", () => {
		const { repoA, repoB, state, workspace } = fixture();
		const both = { ...state, catalog: { revision: 0, workspaces: [...state.catalog.workspaces, { id: "two", name: "Two", paths: [repoA] }] } };
		expect(resolveWorkspaceScope({ cwd: repoA }, both).issue).toBe("ambiguous_workspace");
		const duplicate = join(repoA, "duplicate");
		mkdirSync(duplicate);
		const nestedState = { ...state, catalog: { revision: 0, workspaces: [{ id: "one", name: "One", paths: [repoA, repoB, duplicate] }] } };
		const nested = resolveWorkspaceScope({ cwd: repoA }, nestedState);
		const same = join(repoB, "duplicate");
		mkdirSync(same);
		const withDuplicate = resolveWorkspaceScope({ cwd: repoA }, { ...nestedState, catalog: { revision: 0, workspaces: [{ id: "one", name: "One", paths: [repoA, repoB, duplicate, same] }] } });
		expect(() => resolveRequestScope("只查看 duplicate", withDuplicate.scope)).toThrow(KnowledgeScopeError);
		expect(workspace.scope.workspaceId).toBe("one");
	});

	it("revokes evidence when the conversation, Workspace or knowledge library changes", () => {
		const { repoA, library, state, workspace } = fixture();
		const source = workspace.scope.sources[0];
		const evidence: KnowledgeEvidence = {
			id: "ev_test", requestId: "r1", conversationId: "c1", requestCwd: repoA, workspaceId: "one", scopeSourceIds: [source.id], source,
			path: "answer.ts", startLine: 1, endLine: 1, fingerprint: "abc", workingTree: "clean",
		};
		expect(assertKnowledgeEvidenceAccess(evidence, "c1", repoA, state).root).toBe(repoA);
		expect(() => assertKnowledgeEvidenceAccess(evidence, "other", repoA, state)).toThrow(/对话/);
		expect(() => assertKnowledgeEvidenceAccess(evidence, "c1", repoA, { ...state, library: { cwd: library, path: null, available: false } })).not.toThrow();
		const knowledgeEvidence = { ...evidence, source: workspace.scope.sources.find(item => item.kind === "knowledge")!, scopeSourceIds: [workspace.scope.sources.find(item => item.kind === "knowledge")!.id] };
		expect(() => assertKnowledgeEvidenceAccess(knowledgeEvidence, "c1", repoA, { ...state, library: { cwd: library, path: null, available: false } })).toThrow(/知识库/);
	});
});

describe("bounded knowledge reader", () => {
	it("reads original lines and creates evidence only through the hook", async () => {
		const { repoA } = fixture();
		writeFileSync(join(repoA, "answer.ts"), "const first = 1;\nconst second = 2;\n");
		const observed: unknown[] = [];
		const reader = await createKnowledgeSourceReader(repoA, { evidence: async input => { observed.push(input); return "ev_one"; } });
		const read = reader.tools.find(tool => tool.name === "source_read")!;
		const result = await execute(read, { path: "answer.ts", startLine: 2, limit: 1 });
		expect(result.content[0].text).toContain("ev_one");
		expect(result.content[0].text).toContain("answer.ts:2: const second = 2;");
		expect(observed).toEqual([{ path: "answer.ts", startLine: 2, endLine: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
	});

	it("refuses traversal, absolute paths, credentials and symbolic links", async () => {
		const { root, repoA } = fixture();
		writeFileSync(join(repoA, ".env"), "SECRET=visible\n");
		writeFileSync(join(repoA, "auth.json"), "{\"secret\":true}\n");
		writeFileSync(join(root, "outside.txt"), "outside\n");
		symlinkSync(join(root, "outside.txt"), join(repoA, "linked.txt"));
		const reader = await createKnowledgeSourceReader(repoA);
		const read = reader.tools.find(tool => tool.name === "source_read")!;
		for (const path of ["../outside.txt", "/etc/passwd", ".env", "auth.json", "linked.txt"]) await expect(execute(read, { path })).rejects.toThrow();
		const list = await execute(reader.tools.find(tool => tool.name === "source_list")!, {});
		expect(list.content[0].text).not.toContain(".env");
		expect(list.content[0].text).not.toContain("auth.json");
		expect(list.content[0].text).not.toContain("linked.txt");
		const search = await execute(reader.tools.find(tool => tool.name === "source_search")!, { query: "SECRET" });
		expect(search.content[0].text).not.toContain("visible");
	});

	it("signs only complete lines inside the delivered byte budget", async () => {
		const { repoA } = fixture();
		const observations: {startLine: number; endLine: number}[] = [];
		const reader = await createKnowledgeSourceReader(repoA, { evidence: async item => { observations.push(item); return "ev_budget"; } });
		const read = reader.tools.find(tool => tool.name === "source_read")!;
		writeFileSync(join(repoA, "dense.txt"), Array.from({ length: 100 }, () => "范".repeat(1190)).join("\n"));
		const { content } = await execute(read, { path: "dense.txt" });
		const last = observations[0].endLine;
		expect(last).toBeGreaterThan(1);
		expect(last).toBeLessThan(100);
		expect(content[0].text).toContain(`dense.txt:${last}: `);
		expect(content[0].text).not.toContain(`dense.txt:${last + 1}: `);
		writeFileSync(join(repoA, "partial.txt"), "one\n" + "x".repeat(1300) + "\nthree\n");
		await execute(read, { path: "partial.txt" });
		expect(observations.at(-1)).toMatchObject({ startLine: 1, endLine: 1 });
		await execute(read, { path: "partial.txt", startLine: 2 });
		expect(observations).toHaveLength(2);
	});

	it("searches with fixed literal matching and rereads hits", async () => {
		const { repoA } = fixture();
		writeFileSync(join(repoA, "notes.md"), "alpha [literal] value\n");
		const evidence: unknown[] = [];
		const reader = await createKnowledgeSourceReader(repoA, { evidence: async input => { evidence.push(input); return "ev_search"; } });
		const result = await execute(reader.tools.find(tool => tool.name === "source_search")!, { query: "[literal]" });
		expect(result.content[0].text).toContain("notes.md:1");
		expect(result.content[0].text).toContain("ev_search");
		expect(evidence).toHaveLength(1);
	});

	it("rejects a replaced source root", async () => {
		const { repoA } = fixture();
		writeFileSync(join(repoA, "answer.ts"), "one\n");
		const reader = await createKnowledgeSourceReader(repoA);
		rmSync(repoA, { recursive: true, force: true });
		mkdirSync(repoA);
		await expect(execute(reader.tools.find(tool => tool.name === "source_read")!, { path: "answer.ts" })).rejects.toThrow(/root changed|ENOENT/);
	});
});

