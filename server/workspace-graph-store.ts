import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { GraphEdge, GraphNode } from "./protocol.js";
import type { GraphIndexResult, GraphRepoIndex } from "./workspace-graph-index.js";

interface Publication {
	version: string; publishedAt: number; members: Record<string, string>;
	nodes: GraphNode[]; edges: GraphEdge[];
}
interface CatalogRow {
	workspace: string; version: string | null; published: number | null; members: string;
	job: string | null; heartbeat: number; error: string | null;
}
const require = createRequire(import.meta.url);

// The service may run in the desktop and CLI processes at the same time.
// A lease fences late workers; a complete generation is published in one transaction.
export class GraphCatalog {
	private readonly db: DatabaseSync;
	constructor(file: string) {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const sqlite = require("node:sqlite") as typeof import("node:sqlite");
		this.db = new sqlite.DatabaseSync(file);
		this.db.exec(`PRAGMA busy_timeout=5000;
			PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS workspace (
				workspace TEXT PRIMARY KEY, version TEXT, published INTEGER, members TEXT NOT NULL DEFAULT '{}',
				overlay TEXT NOT NULL DEFAULT '{}', job TEXT, heartbeat INTEGER NOT NULL DEFAULT 0, error TEXT);
			CREATE TABLE IF NOT EXISTS repository (
				id TEXT NOT NULL, fingerprint TEXT NOT NULL, artifact TEXT NOT NULL, PRIMARY KEY(id,fingerprint));`);
	}

	state(id: string): CatalogRow | undefined {
		this.db.prepare("UPDATE workspace SET job=NULL,error=? WHERE workspace=? AND job IS NOT NULL AND heartbeat<?")
			.run("Indexing was interrupted.", id, Date.now() - 120_000);
		return this.db.prepare("SELECT workspace,version,published,members,job,heartbeat,error FROM workspace WHERE workspace=?")
			.get(id) as unknown as CatalogRow | undefined;
	}

	begin(id: string): string | undefined {
		this.state(id);
		const lease = randomUUID();
		const changed = this.db.prepare(`INSERT INTO workspace(workspace,job,heartbeat) VALUES(?,?,?)
			ON CONFLICT(workspace) DO UPDATE SET job=excluded.job,heartbeat=excluded.heartbeat,error=NULL WHERE workspace.job IS NULL`)
			.run(id, lease, Date.now()).changes;
		return changed ? lease : undefined;
	}

	heartbeat(id: string, lease: string): boolean {
		return !!this.db.prepare("UPDATE workspace SET heartbeat=? WHERE workspace=? AND job=?").run(Date.now(), id, lease).changes;
	}

	fail(id: string, lease: string, error: string) {
		this.db.prepare("UPDATE workspace SET job=NULL,error=? WHERE workspace=? AND job=?").run(error, id, lease);
	}

	repository(id: string, fingerprint?: string): GraphRepoIndex | undefined {
		const row = fingerprint
			? this.db.prepare("SELECT artifact FROM repository WHERE id=? AND fingerprint=?").get(id, fingerprint)
			: this.db.prepare("SELECT artifact FROM repository WHERE id=? ORDER BY rowid DESC LIMIT 1").get(id);
		return row ? JSON.parse(String(row.artifact)) : undefined;
	}

	publication(id: string): Publication | undefined {
		const row = this.db.prepare("SELECT version,published,members,overlay FROM workspace WHERE workspace=?").get(id);
		if (!row?.version) return;
		return { ...JSON.parse(String(row.overlay)), version: String(row.version), publishedAt: Number(row.published), members: JSON.parse(String(row.members)) };
	}

	publish(id: string, lease: string, index: GraphIndexResult) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const members = Object.fromEntries(index.repositories.map(r => [r.id, r.fingerprint]));
			const published = this.db.prepare("UPDATE workspace SET version=?,published=?,members=?,overlay=?,job=NULL,error=NULL WHERE workspace=? AND job=?")
				.run(randomUUID(), Date.now(), JSON.stringify(members), JSON.stringify({ nodes: index.nodes, edges: index.edges }), id, lease);
			if (published.changes) {
				const insert = this.db.prepare(`INSERT INTO repository(id,fingerprint,artifact) VALUES(?,?,?)
					ON CONFLICT(id,fingerprint) DO UPDATE SET artifact=excluded.artifact WHERE repository.artifact<>excluded.artifact`);
				for (const repo of index.repositories) insert.run(repo.id, repo.fingerprint, JSON.stringify(repo));
				this.db.exec(`DELETE FROM repository WHERE NOT EXISTS (
					SELECT 1 FROM workspace, json_each(workspace.members) AS member
					WHERE member.key=repository.id AND member.value=repository.fingerprint)`);
			}
			this.db.exec("COMMIT");
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}

	unchanged(id: string, lease: string) {
		this.db.prepare("UPDATE workspace SET job=NULL,error=NULL WHERE workspace=? AND job=?").run(id, lease);
	}
	close() { this.db.close(); }
}
