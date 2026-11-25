import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeToolHost } from "../../server/knowledge-host.js";
import type { KnowledgeEvidence, KnowledgeRequestContext } from "../../server/knowledge-requests.js";
import { resolveWorkspaceScope, type KnowledgeSourceState } from "../../server/knowledge-sources.js";
import { createKnowledgeWriteTool } from "../../server/knowledge-write.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "knowledge-write-")); roots.push(root);
	const repo = join(root, "repo"), library = join(root, "library");
	mkdirSync(join(library, "entries"), { recursive: true });
	mkdirSync(repo, { recursive: true });
	const state: KnowledgeSourceState = {
		catalog: { revision: 0, workspaces: [{ id: "one", name: "One", paths: [repo] }] },
		library: { cwd: library, path: null, available: true },
	};
	const scope = resolveWorkspaceScope({ cwd: repo }, state).scope;
	const repoSource = scope.sources.find(source => source.kind === "repository")!;
	const librarySource = scope.sources.find(source => source.kind === "knowledge")!;
	return { root, repo, library, state, scope, repoSource, librarySource };
}

function evidence(request: KnowledgeRequestContext, id: string, overrides: Partial<KnowledgeEvidence> = {}): KnowledgeEvidence {
	const repoSource = request.scope.sources.find(source => source.kind === "repository")!;
	return {
		id, requestId: request.requestId, conversationId: request.conversationId, requestCwd: request.scope.requestCwd,
		workspaceId: request.scope.workspaceId, scopeSourceIds: [repoSource.id], source: repoSource,
		path: "src/a.ts", startLine: 10, endLine: 12, fingerprint: "a".repeat(64), revision: "rev1", workingTree: "clean",
		...overrides,
	};
}

function setup() {
	const { library, state, scope } = fixture();
	const contexts: KnowledgeRequestContext[] = [];
	const host = {
		getContext: () => contexts.at(-1),
		sourceState: () => state,
		recordEvidence: () => { },
		parent: () => { throw new Error("unused"); },
		wiki: {
			knowledgeDocument: (cwd: string, path: string) => {
				const absolute = join(cwd, path);
				return { absolute, path, current: existsSync(absolute) ? readFileSync(absolute) : undefined };
			},
			writeKnowledgeDocument: (cwd: string, path: string, text: string) => {
				const absolute = join(cwd, path);
				const status = existsSync(absolute) ? "updated" : "created";
				writeFileSync(absolute, text);
				return { status, version: hash(text), diskWritten: true, warnings: [] };
			},
		},
	} as unknown as KnowledgeToolHost;
	const request = (requestId: string, sessionId: string): KnowledgeRequestContext => {
		const context: KnowledgeRequestContext = {
			mode: "learn", requestId, conversationId: "c1", sessionId, root: `root-${requestId}`,
			rawCommand: "/learn", skillPath: "/skills/learn/SKILL.md", scope, evidence: new Map(), evidenceOrder: [],
		};
		contexts.push(context);
		return context;
	};
	const tool = createKnowledgeWriteTool(host);
	const confirm = { approved: 0 };
	const ctx = { ui: { confirm: async () => { confirm.approved++; return true; } } };
	const write = (params: Record<string, unknown>) => tool.execute("t1", params as never, undefined, undefined, ctx as never);
	const read = (path: string) => readFileSync(join(library, path), "utf8");
	return { library, request, write, read, confirm };
}

describe("knowledge_write", () => {
	it("creates an entry with server-generated provenance from this request's evidence", async () => {
		const { request, write, read } = setup();
		const context = request("r1", "s1");
		const ev = evidence(context, "ev1");
		context.evidence.set(ev.id, ev);
		const result = await write({ path: "entries/mcp.md", text: "---\nstatus: inferred\n---\n# MCP 生命周期\n\n初始化由宿主负责。\n", evidenceIds: ["ev1"] });
		expect(JSON.stringify(result.content)).toContain("created");
		const saved = read("entries/mcp.md");
		expect(saved).toContain('session: "s1"');
		expect(saved).toContain(`sourceId: ${JSON.stringify(ev.source.id)}`);
		expect(saved).toContain('lines: "10-12"');
		expect(saved).toContain(`sha256: "${"a".repeat(64)}"`);
		expect(saved).toContain('revision: "rev1"');
		expect(saved).toContain("status: inferred");
		expect(saved).toContain('title: "MCP 生命周期"');
		expect(saved).toMatch(/updated: \d{4}-\d{2}-\d{2}/);
	});

	it("preserves historical sources and dedups repeated evidence across updates", async () => {
		const { request, write, read } = setup();
		const first = request("r1", "s1");
		const ev1 = evidence(first, "ev1");
		first.evidence.set(ev1.id, ev1);
		await write({ path: "entries/mcp.md", text: "# MCP\n\n初版。\n", evidenceIds: ["ev1"] });

		const second = request("r2", "s2");
		const repeated = evidence(second, "ev2");
		const added = evidence(second, "ev3", { path: "src/b.ts", startLine: 40, endLine: 40, fingerprint: "b".repeat(64), revision: "rev2" });
		second.evidence.set(repeated.id, repeated);
		second.evidence.set(added.id, added);
		const result = await write({ path: "entries/mcp.md", text: "# MCP\n\n初版。\n\n补充：重试策略。\n", expectedVersion: hash(read("entries/mcp.md")), evidenceIds: ["ev2", "ev3"] });
		expect(JSON.stringify(result.content)).toContain("updated");
		const saved = read("entries/mcp.md");
		expect(saved).toContain('session: "s1"');
		expect(saved).toContain('session: "s2"');
		expect(saved.match(/src\/a\.ts/g)).toHaveLength(1);
		expect(saved.match(/src\/b\.ts/g)).toHaveLength(1);
		expect(saved).toContain("重试策略");
	});

	it("reports unchanged without prompting or writing when nothing material changed", async () => {
		const { request, write, read, confirm } = setup();
		const first = request("r1", "s1");
		const ev1 = evidence(first, "ev1");
		first.evidence.set(ev1.id, ev1);
		await write({ path: "entries/mcp.md", text: "# MCP\n\n初版。\n", evidenceIds: ["ev1"] });
		const before = read("entries/mcp.md");
		expect(confirm.approved).toBe(1);

		const second = request("r2", "s1");
		const same = evidence(second, "ev9");
		second.evidence.set(same.id, same);
		const result = await write({ path: "entries/mcp.md", text: "# MCP\n\n初版。\n", expectedVersion: hash(before), evidenceIds: ["ev9"] });
		const payload = JSON.stringify(result.content);
		expect(payload).toContain("unchanged");
		expect(payload).toContain('diskWritten\\":false');
		expect(read("entries/mcp.md")).toBe(before);
		expect(confirm.approved).toBe(1);
	});

	it("rejects a stale expectedVersion and never overwrites conflicting content silently", async () => {
		const { request, write, read } = setup();
		const first = request("r1", "s1");
		await write({ path: "entries/mcp.md", text: "# MCP\n\n初版。\n" });
		const before = read("entries/mcp.md");

		const second = request("r2", "s2");
		await expect(write({ path: "entries/mcp.md", text: "# MCP\n\n冲突改写。\n", expectedVersion: hash("outdated snapshot") }))
			.rejects.toThrow(/changed; reread/);
		await expect(write({ path: "entries/mcp.md", text: "# MCP\n\n无版本改写。\n" }))
			.rejects.toThrow(/expectedVersion is required/);
		expect(read("entries/mcp.md")).toBe(before);
	});

	it("rejects foreign evidence and invalid status values", async () => {
		const { request, write, library } = setup();
		const context = request("r1", "s1");
		const other = evidence(context, "evX", { requestId: "someone-else" });
		context.evidence.set(other.id, other);
		await expect(write({ path: "entries/mcp.md", text: "# MCP\n\n内容。\n", evidenceIds: ["ev1"] }))
			.rejects.toThrow(/Unknown evidenceId/);
		await expect(write({ path: "entries/bogus.md", text: "---\nstatus: certain\n---\n# Bogus\n\n内容。\n" }))
			.rejects.toThrow(/Invalid knowledge status/);
		expect(existsSync(join(library, "entries", "mcp.md"))).toBe(false);
		expect(existsSync(join(library, "entries", "bogus.md"))).toBe(false);
	});
});
