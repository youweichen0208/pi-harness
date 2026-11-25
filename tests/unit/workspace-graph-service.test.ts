import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { WorkspaceGraphService } from "../../server/workspace-graph.js";

async function settled(graph: WorkspaceGraphService, id: string) {
	for (let i = 0; i < 200; i++) {
		const status = await graph.execute(id, { op: "graph_status" });
		if (status.state !== "building" && status.state !== "updating") return status;
		await delay(50);
	}
	throw Error("Workspace graph job did not settle");
}

it("publishes atomically, reopens, deduplicates jobs, and drops stale and withdrawn evidence", async () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-graph-service-"));
	const roots = ["client", "library"].map(name => join(temp, name));
	for (const root of roots) {
		mkdirSync(root);
		writeFileSync(join(root, "entry.ts"), 'import "./value.js";\n');
		writeFileSync(join(root, "value.ts"), "export const value = 1;\n");
	}
	const workspace = { id: "one", name: "one", paths: [...roots] };
	const store = () => ({ revision: 1, workspaces: [workspace] });
	const first = new WorkspaceGraphService(join(temp, "data"), store);
	const second = new WorkspaceGraphService(join(temp, "data"), store);
	const search = { op: "graph_search", query: "" } as const;
	try {
		expect((await first.execute("one", search)).state).toBe("not_indexed");
		await expect(first.execute("one", { op: "graph_update" })).rejects.toThrow("baseline");
		const building = await first.execute("one", { op: "graph_build" });
		expect(building.state).toBe("building");
		expect((await second.execute("one", { op: "graph_build" })).state).toBe("building");
		const ready = await settled(second, "one");
		expect(ready.state).toBe("ready");
		const current = await second.execute("one", search);
		const use = current.edges.find(e => e.anchors[0].sourceId === current.sources[0].id)!;
		const other = current.edges.find(e => e.id !== use.id)!;
		expect(use).toBeTruthy();
		expect((await first.execute("one", { op: "graph_evidence", edgeId: use.id, anchor: 0 })).evidence?.lines[0]).toContain("import");
		expect((await first.execute("one", { op: "graph_path", from: use.from, to: use.to })).edges).toEqual([use]);
		expect((await first.execute("one", { op: "graph_impact", nodeId: use.to })).edges).toEqual([use]);
		expect((await first.execute("one", search, [current.sources[1].id])).edges).toEqual([other]);
		await expect(first.execute("one", { op: "graph_build" }, [current.sources[1].id])).rejects.toThrow("full");
		await first.execute("one", { op: "graph_update" });
		expect((await settled(first, "one")).version).toBe(ready.version);

		writeFileSync(join(roots[0], "value.ts"), "export const broken = ;");
		const stale = await second.execute("one", search);
		expect(stale.state).toBe("stale");
		expect(stale.edges).toEqual([other]);
		await first.execute("one", { op: "graph_update" });
		const failed = await settled(second, "one");
		expect(failed.state).toBe("failed");
		expect(failed.version).toBe(ready.version);
		expect((await first.execute("one", search)).edges).toEqual([other]);
		await expect(first.execute("one", { op: "graph_evidence", edgeId: use.id, anchor: 0 })).rejects.toThrow("stale");

		workspace.paths = [roots[1]];
		expect((await first.execute("one", search)).error).toBe("Index refresh failed.");
		workspace.paths = [roots[0]];
		expect((await first.execute("one", search)).edges).toEqual([]);
		writeFileSync(join(roots[0], "value.ts"), "export const value = 3;");
		await second.execute("one", { op: "graph_update" });
		const refreshed = await settled(first, "one");
		expect(refreshed.state).toBe("ready");
		expect(refreshed.version).not.toBe(ready.version);
		expect((await second.execute("one", search)).sources).toHaveLength(1);
		const db = new DatabaseSync(join(temp, "data", "graph", "catalog.db"));
		try { db.exec("UPDATE repository SET artifact='invalid JSON'"); } finally { db.close(); }
		await first.execute("one", { op: "graph_build" });
		expect((await settled(first, "one")).state).toBe("ready");
		expect((await second.execute("one", search)).edges).toHaveLength(1);
	} finally {
		await first.close(); await second.close();
		rmSync(temp, { force: true, recursive: true });
	}
}, 30000);
