import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { KnowledgeLibrary } from "../../server/knowledge-library.js";
import { ProjectWorkspaceStore } from "../../server/project-workspaces.js";
import { readSubagentSources, resolveSubagentSources } from "../../server/subagents/sources.js";

const base = join(tmpdir(), "subagent-source-fixture");
const [current, other, unrelated, knowledge] = ["current", "other", "unrelated", "knowledge"].map(name => join(base, name));
const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("subagent source scope", () => {
	it("includes the current repository, its single workspace, and the independent knowledge library", () => {
		const result = resolveSubagentSources({ cwd: current }, {
			catalog: { revision: 1, workspaces: [{ id: "work", name: "Work", paths: [current, other] }, { id: "unrelated", name: "Unrelated", paths: [unrelated] }] },
			library: { cwd: knowledge, available: true },
		});
		expect(result.workspace).toEqual({ id: "work", name: "Work" });
		expect(result.sources.map(({ kind, root }) => ({ kind, root }))).toEqual([
			{ kind: "repository", root: current }, { kind: "repository", root: other }, { kind: "knowledge", root: knowledge },
		]);
		expect(result.issue).toBeUndefined();
	});

	it("requires an explicit choice for shared membership instead of unioning unrelated repositories", () => {
		const state = {
			catalog: { revision: 1, workspaces: [{ id: "one", name: "One", paths: [current, other] }, { id: "two", name: "Two", paths: [current, unrelated] }] },
			library: { cwd: knowledge, available: true },
		};
		const ambiguous = resolveSubagentSources({ cwd: current }, state);
		expect(ambiguous.issue).toBe("ambiguous_workspace");
		expect(ambiguous.workspace).toBeUndefined();
		expect(ambiguous.workspaces).toEqual([{ id: "one", name: "One" }, { id: "two", name: "Two" }]);
		expect(ambiguous.sources.map(source => source.root)).toEqual([current, knowledge]);
		expect(resolveSubagentSources({ cwd: current, workspaceId: "two" }, state).sources.map(source => source.root)).toEqual([current, unrelated, knowledge]);
	});

	it("does not expand a missing or mismatched selected group", () => {
		const state = { catalog: { revision: 1, workspaces: [{ id: "elsewhere", name: "Elsewhere", paths: [unrelated] }] }, library: { cwd: knowledge, available: false } };
		for (const [workspaceId, issue] of [["missing", "workspace_unavailable"], ["elsewhere", "workspace_mismatch"]]) {
			const result = resolveSubagentSources({ cwd: current, workspaceId }, state);
			expect(result.issue).toBe(issue);
			expect(result.sources.map(source => source.root)).toEqual([current]);
		}
	});

	it("keeps missing registered paths and stable, distinct source identities across catalog changes", () => {
		const initial = { catalog: { revision: 1, workspaces: [{ id: "one", name: "One", paths: [current, other, `${other}${sep}.`] }] }, library: { cwd: current, available: true } };
		const before = resolveSubagentSources({ cwd: current }, initial);
		const after = resolveSubagentSources({ cwd: current }, { ...initial, catalog: { revision: 2, workspaces: [{ id: "new-group", name: "Renamed", paths: [other, current] }] } });
		expect(before.sources).toHaveLength(3);
		expect(before.sources.map(source => source.id)).toEqual(after.sources.map(source => source.id));
		expect(before.sources[0].id).not.toBe(before.sources[2].id);
		expect(() => resolveSubagentSources({ cwd: "relative" }, initial)).toThrow(/absolute/);
	});

	it("reads the shared catalog override and live library configuration from the configured data directory", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-sources-"))); roots.push(root);
		const cwd = join(root, "repo"), peer = join(root, "peer"), first = join(root, "notes-a"), second = join(root, "notes-b");
		for (const path of [cwd, peer, first, second]) mkdirSync(path);
		const dataDir = join(root, "data"), catalogFile = join(root, "shared", "workspaces.json");
		vi.stubEnv("PI_WEB_DATA_DIR", dataDir); vi.stubEnv("PI_WEB_WORKSPACES_FILE", catalogFile);
		const store = new ProjectWorkspaceStore(catalogFile);
		const id = store.apply(0, { kind: "create", name: "Team" }).workspaceId;
		store.apply(1, { kind: "add", id, path: cwd }); store.apply(2, { kind: "add", id, path: peer });
		const library = new KnowledgeLibrary(dataDir); library.configure(first);
		expect(readSubagentSources(cwd).sources.map(source => source.root)).toEqual([cwd, peer, first]);
		library.configure(second); rmSync(peer, { recursive: true });
		expect(readSubagentSources(cwd, id).sources.map(source => source.root)).toEqual([cwd, peer, second]);
		vi.stubEnv("PI_WEB_WORKSPACES_FILE", "");
		expect(readSubagentSources(cwd).sources.map(source => source.root)).toEqual([cwd, second]);
	});
});
