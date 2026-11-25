import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fingerprintGraphSources, indexWorkspaceGraph } from "../../server/workspace-graph-index.js";

const trash: string[] = [];
afterEach(() => { for (const root of trash.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const tmp = mkdtempSync(join(tmpdir(), "pi-ws-graph-"));
	trash.push(tmp);
	const root = join(tmp, "repo");
	mkdirSync(root);
	const put = (name: string, contents: string) => {
		const file = join(root, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents);
	};
	return { tmp, root, sources: [{ id: "one", root }], put };
}

it("fingerprints eligible files using ignore rules and refreshes path and byte changes", async () => {
	const { tmp, root, put, sources } = fixture();
	put("a.ts", 'import { b } from "./b";\nexport { b };\n');
	put("b/index.ts", "export const b = 1;\n");
	put(".gitignore", "ignored/\n");
	for (const file of ["ignored/sample.ts", "vendor/dependency.ts", ".hidden/hidden.ts", "node_modules/a.ts", "a.generated.ts", "secrets.ts"]) put(file, "unavailable");
	const outside = join(tmp, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "other.ts"), "unavailable");
	symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
	const baseline = await indexWorkspaceGraph(sources);
	const [repo] = baseline.repositories;
	expect(Object.keys(repo.files)).toEqual(["a.ts", "b/index.ts"]);
	expect(repo.edges).toHaveLength(1);
	expect(repo.edges[0].anchors.map(a => [a.sourceId, a.path, a.sha256])).toEqual([
		["one", "a.ts", repo.files["a.ts"]], ["one", "b/index.ts", repo.files["b/index.ts"]],
	]);
	expect(await fingerprintGraphSources(sources)).toEqual({ one: repo.fingerprint });
	put("ignored/sample.ts", "changed");
	expect(await fingerprintGraphSources(sources)).toEqual({ one: repo.fingerprint });
	put("b/index.ts", "export const b = 7;\n");
	const updated = (await indexWorkspaceGraph(sources, [repo])).repositories[0];
	expect(updated.edges[0].anchors[1].sha256).toBe(updated.files["b/index.ts"]);
	expect(updated.edges[0].id).not.toBe(repo.edges[0].id);
	put("a.ts", 'import "./b/missing";\n');
	const missing = (await indexWorkspaceGraph(sources, [updated])).repositories[0];
	expect(missing.edges).toEqual([]);
	put("b/missing.ts", "export {};");
	expect((await indexWorkspaceGraph(sources, [missing])).repositories[0].edges[0].anchors[1].path).toBe("b/missing.ts");
	put("new.ts", "export const c = 2;");
	expect((await fingerprintGraphSources(sources)).one).not.toEqual(repo.fingerprint);
}, 15_000);

it("rejects malformed or oversized source and cancels without publishing", async () => {
	const { put, sources } = fixture();
	put("bad.ts", "export const = ;");
	await expect(indexWorkspaceGraph(sources)).rejects.toThrow("Cannot parse TypeScript file");
	put("bad.ts", " ".repeat(1024 * 1024 + 1));
	await expect(indexWorkspaceGraph(sources)).rejects.toThrow("1 MiB");
	const controller = new AbortController();
	controller.abort();
	await expect(indexWorkspaceGraph(sources, [], controller.signal)).rejects.toThrow();
});

it("links named package imports and re-exports only for a unique pinned dependency with a real public binding", async () => {
	const { tmp, put, sources } = fixture();
	const library = join(tmp, "library");
	mkdirSync(library);
	const pkg = { name: "local-lib", version: "1.0.0", exports: { ".": { types: "./api.d.ts" } } };
	writeFileSync(join(library, "package.json"), JSON.stringify(pkg));
	writeFileSync(join(library, "api.d.ts"), "// public API\nexport declare const run: () => void;\n");
	put("package.json", JSON.stringify({ dependencies: { "local-lib": "1.0.0" } }));
	put("web.ts", 'import { run as go } from "local-lib";\nexport { run as capture } from "local-lib";\n');
	put("unrelated.ts", 'import { unrelated } from "local-lib";\n');
	const scope = [...sources, { id: "lib", root: library }];
	const built = await indexWorkspaceGraph(scope);
	const overview = built.edges.filter(edge => edge.from === "one" && edge.to === "lib");
	expect(overview.map(edge => edge.label)).toEqual(["imports local-lib", "re-exports local-lib"]);
	expect(built.edges).toHaveLength(4);
	for (const edge of overview) {
		expect(edge.anchors.map(a => [a.role, a.sourceId, a.path])).toEqual([["import", "one", "web.ts"], ["export", "lib", "api.d.ts"]]);
		expect(edge.anchors[1].line).toBe(2);
	}
	const duplicate = join(tmp, "duplicate");
	mkdirSync(duplicate);
	writeFileSync(join(duplicate, "package.json"), JSON.stringify(pkg));
	expect((await indexWorkspaceGraph([...scope, { id: "other", root: duplicate }])).edges).toEqual([]);
	put("package.json", JSON.stringify({ dependencies: { "local-lib": "^1.0.0" } }));
	expect((await indexWorkspaceGraph(scope, built.repositories)).edges).toEqual([]);
	put("package.json", JSON.stringify({ dependencies: { "local-lib": "1.0.0" } }));
	writeFileSync(join(library, "package.json"), JSON.stringify({ ...pkg, exports: { "./internal": "./api.d.ts" } }));
	expect((await indexWorkspaceGraph(scope)).edges).toEqual([]);
	writeFileSync(join(library, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, types: "api.ts" }));
	writeFileSync(join(library, "api.ts"), "export const run = () => {};\n");
	expect((await indexWorkspaceGraph(scope)).edges.filter(e => e.from === "one")).toHaveLength(2);
}, 15_000);
