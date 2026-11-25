import { createHash } from "node:crypto";
import { join } from "node:path";
import { knowledgeSource } from "./knowledge-sources.js";
import { createKnowledgeSourceReader } from "./knowledge-source-reader.js";
import type { GraphEdge, GraphNode, ProjectWorkspaceCatalog, WorkspaceGraphRequest, WorkspaceGraphResult } from "./protocol.js";
import { GraphCatalog } from "./workspace-graph-store.js";
import { queryGraph } from "./workspace-graph-query.js";
import type { GraphIndexSource } from "./workspace-graph-index.js";

const identity = (sources: readonly GraphIndexSource[]) => JSON.stringify(sources.map(s => s.id).sort());
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class WorkspaceGraphService {
	private catalog?: GraphCatalog;
	private closing = false;
	private readonly jobs = new Map<string, { abort: AbortController; done: Promise<void> }>();
	private readonly checks = new Map<string, Promise<Record<string, string>>>();
	private readonly stop = new AbortController();

	constructor(private dataDir: string, private workspaces: () => ProjectWorkspaceCatalog, private libraryRoot: () => string | null = () => null) {}

	private get store() {
		if (this.closing) throw Error("Graph service closed.");
		return this.catalog ??= new GraphCatalog(join(this.dataDir, "graph", "catalog.db"));
	}

	private scope(id: string) {
		const group = this.workspaces().workspaces.find(w => w.id === id);
		if (!group) throw Error("Workspace unavailable.");
		return [...new Map(group.paths.map(root => {
			const item = knowledgeSource("repository", root);
			return [item.id, item] as const;
		})).values()];
	}

	private failureText(raw: string, sources: readonly GraphIndexSource[]) {
		try {
			const failure = JSON.parse(raw);
			if (failure.scope === identity(sources) && typeof failure.message === "string") return failure.message;
		} catch { /* Older records do not carry a verifiable scope. */ }
		return raw === "Indexing was interrupted." ? raw : "Index refresh failed.";
	}

	private fingerprints(sources: GraphIndexSource[]) {
		const key = identity(sources);
		const current = this.checks.get(key);
		if (current) return current;
		const pending = import("./workspace-graph-index.js").then(index => index.fingerprintGraphSources(sources, this.stop.signal))
			.finally(() => this.checks.delete(key));
		this.checks.set(key, pending);
		return pending;
	}

	private start(id: string, sources: GraphIndexSource[], update: boolean) {
		const lease = this.store.begin(id);
		if (!lease) return;
		const abort = new AbortController();
		const heartbeat = setInterval(() => {
			if (!this.catalog?.heartbeat(id, lease)) abort.abort();
		}, 15_000);
		heartbeat.unref();
		const done = (async () => {
			try {
				const index = await import("./workspace-graph-index.js");
				if (update) {
					const published = this.store.state(id);
					const old: Record<string, string> = JSON.parse(published?.members ?? "{}");
					const now = await index.fingerprintGraphSources(sources, abort.signal);
					if (Object.keys(old).length === sources.length && sources.every(s => old[s.id] === now[s.id])
						&& identity(this.scope(id)) === identity(sources)) {
						this.store.unchanged(id, lease);
						return;
					}
				}
				// Explicitly rebuilding an existing baseline also repairs its derived artifacts.
				const forceRebuild = !update && !!this.store.state(id)?.version;
				const prior = forceRebuild ? [] : sources.flatMap(s => this.store.repository(s.id) ?? []);
				const result = await index.indexWorkspaceGraph(sources, prior, abort.signal);
				abort.signal.throwIfAborted();
				const now = await index.fingerprintGraphSources(sources, abort.signal);
				if (result.repositories.length !== sources.length || result.repositories.some(r => now[r.id] !== r.fingerprint)
					|| identity(this.scope(id)) !== identity(sources)) throw Error("Workspace changed during indexing. Refresh to retry.");
				this.store.publish(id, lease, result);
			} catch (error) {
				this.catalog?.fail(id, lease, JSON.stringify({ scope: identity(sources), message: message(error) }));
			} finally {
				clearInterval(heartbeat);
				this.jobs.delete(lease);
			}
		})();
		this.jobs.set(lease, { abort, done });
	}

	async execute(workspaceId: string, request: WorkspaceGraphRequest, allowedSourceIds?: readonly string[]): Promise<WorkspaceGraphResult> {
		const all = this.scope(workspaceId);
		const visible = all.filter(s => !allowedSourceIds || allowedSourceIds.includes(s.id));
		const whole = visible.length === all.length;
		const manage = request.op === "graph_build" || request.op === "graph_update";
		if (manage) {
			if (!whole || !visible.length) throw Error("Indexing requires the full, non-empty Workspace.");
			if (request.op === "graph_update" && !this.store.state(workspaceId)?.version) throw Error("Build the Workspace baseline first.");
			this.start(workspaceId, all, request.op === "graph_update");
		}
		const row = this.store.state(workspaceId);
		const result: WorkspaceGraphResult = {
			workspaceId, sources: visible.map(({ id, name }) => ({ id, name })), nodes: [], edges: [],
			state: row?.job ? (row.version ? "updating" : "building") : row?.error ? "failed" : row?.version ? "ready" : "not_indexed",
			...(row?.version ? { version: row.version, publishedAt: row.published ?? undefined } : {}),
			...(row?.error ? { error: whole ? this.failureText(row.error, all) : "Index refresh failed." } : {}),
		};
		const review = async (nodes: GraphNode[]) => {
			if (request.op !== "graph_document") return result;
			if (allowedSourceIds) throw Error("Document review requires an explicit library selection.");
			const { reviewGraphDocument } = await import("./graph-knowledge-document.js");
			const modules = new Map(nodes.filter(n => n.kind === "module" && n.anchor).map(n => [JSON.stringify([n.sourceId, n.anchor!.path, n.anchor!.sha256]), n.id]));
			result.review = await reviewGraphDocument(request.path, {
				library: this.libraryRoot, sources: () => this.scope(workspaceId),
				findNode: async (id, path, sha256) => modules.get(JSON.stringify([id, path, sha256])),
			});
			return result;
		};
		if (!row?.version || manage || (row.job && request.op === "graph_status")) return review([]);
		const publication = this.store.publication(workspaceId);
		if (!publication || publication.version !== row.version) throw Error("Workspace graph has changed. Retry.");
		const recheckScope = () => {
			if (identity(all) !== identity(this.scope(workspaceId))) throw Error("Workspace membership changed. Retry.");
		};
		const nodes: GraphNode[] = [], edges: GraphEdge[] = [];
		const valid = new Set<string>();
		// Fail closed independently per source so unaffected local dependencies
		// survive a deleted repository or an interrupted workspace refresh.
		const known = visible.filter(s => Object.hasOwn(publication.members, s.id));
		let combined: Record<string, string> | undefined;
		if (known.length > 1) {
			try { combined = await this.fingerprints(known); } catch { /* Check each surviving source below. */ }
		}
		for (const s of known) {
			try {
				const fresh = combined ?? await this.fingerprints([s]);
				if (publication.members[s.id] !== fresh[s.id]) continue;
			} catch { continue; }
			valid.add(s.id);
			if (request.op === "graph_status") continue;
			const artifact = this.store.repository(s.id, publication.members[s.id]);
			if (artifact) {
				for (const node of artifact.nodes) nodes.push(node);
				for (const edge of artifact.edges) edges.push(edge);
			}
		}
		recheckScope();
		const membershipMatches = Object.keys(publication.members).length === all.length && all.every(s => Object.hasOwn(publication.members, s.id));
		const current = valid.size === visible.length && membershipMatches;
		result.freshness = createHash("sha256").update(JSON.stringify([publication.version, membershipMatches, [...valid].sort()])).digest("hex");
		if (!current && result.state === "ready") result.state = "stale";
		if (request.op === "graph_status") return result;
		// Overlay proofs can transitively depend on a barrel, package or build
		// config in any member. Include them only for the entire verified scope.
		if (whole && current) { nodes.push(...publication.nodes); edges.push(...publication.edges); }
		if (request.op === "graph_document") return review(nodes);
		if (request.op === "graph_evidence") {
			const edge = edges.find(e => e.id === request.edgeId);
			const anchor = edge?.anchors[request.anchor];
			const source = visible.find(s => s.id === anchor?.sourceId);
			if (!source || !anchor) throw Error("Graph evidence is unavailable or stale.");
			const file = await (await createKnowledgeSourceReader(source.root)).readText(anchor.path);
			recheckScope();
			if (file.sha256 !== anchor.sha256 || anchor.line < 1 || anchor.line > file.lines.length) throw Error("Graph evidence is stale.");
			const firstLine = Math.max(1, anchor.line - 3);
			result.evidence = { anchor, firstLine, lines: file.lines.slice(firstLine - 1, Math.min(anchor.line + 16, anchor.endLine + 3)).map(s => s.slice(0, 2000)) };
			return result;
		}
		return Object.assign(result, queryGraph(request, nodes, edges));
	}

	async close() {
		this.closing = true;
		this.stop.abort();
		for (const job of this.jobs.values()) job.abort.abort();
		await Promise.allSettled([...this.jobs.values()].map(job => job.done));
		await Promise.allSettled(this.checks.values());
		this.catalog?.close();
	}
}
