import type { GraphEdge, GraphNode, WorkspaceGraphRequest } from "./protocol.js";

const limit = 60;

export function parseGraphRequest(value: unknown): WorkspaceGraphRequest {
	if (!value || typeof value !== "object") throw Error("Invalid graph request.");
	const data = value as Record<string, unknown>;
	const field = (name: string, max = 2048, empty = false): string => {
		const v = data[name];
		if (typeof v !== "string" || (!empty && !v.length) || v.length > max) throw Error("Invalid graph field: " + name);
		return v;
	};
	switch (data.op) {
		case "graph_status": case "graph_update": case "graph_build": return { op: data.op };
		case "graph_search": return { op: data.op, query: field("query", 256, true), ...(data.sourceId === undefined ? {} : { sourceId: field("sourceId") }) };
		case "graph_document": return { op: data.op, path: field("path") };
		case "graph_neighbors": case "graph_impact": return { op: data.op, nodeId: field("nodeId") };
		case "graph_path": return { op: data.op, from: field("from"), to: field("to") };
		case "graph_evidence": {
			if (!Number.isSafeInteger(data.anchor) || Number(data.anchor) < 0) throw Error("Invalid evidence position.");
			return { op: data.op, edgeId: field("edgeId"), anchor: Number(data.anchor) };
		}
		default: throw Error("Unknown graph operation.");
	}
}

export function queryGraph(request: WorkspaceGraphRequest, items: GraphNode[], relations: GraphEdge[]) {
	const byId = new Map(items.map(node => [node.id, node]));
	const edges = [...new Map(relations.filter(e => byId.has(e.from) && byId.has(e.to)).map(e => [e.id, e])).values()];
	const nodes = new Map<string, GraphNode>();
	let matches: GraphEdge[] = [], truncated = false;

	if (request.op === "graph_search") {
		const q = request.query.trim().toLowerCase();
		const found = [...byId.values()].filter(node => (!request.sourceId || node.sourceId === request.sourceId)
			&& (node.label + " " + (node.anchor?.path ?? "")).toLowerCase().includes(q));
		const foundIds = new Set(found.map(node => node.id));
		for (const n of found.slice(0, limit)) nodes.set(n.id, n);
		truncated = found.length > limit;
		matches = edges.filter(e => (!request.sourceId || byId.get(e.from)?.sourceId === request.sourceId || byId.get(e.to)?.sourceId === request.sourceId)
			&& (foundIds.has(e.from) || foundIds.has(e.to) || e.label.toLowerCase().includes(q)));
		// Cross-repository relationships come first in the workspace overview.
		const priority = (e: GraphEdge) => (byId.get(e.from)?.sourceId !== byId.get(e.to)?.sourceId ? 2 : 0) + Number(e.kind === "flow");
		matches.sort((a, b) => priority(b) - priority(a));
	} else if (request.op === "graph_neighbors") {
		const center = byId.get(request.nodeId);
		if (center) nodes.set(center.id, center);
		matches = edges.filter(e => e.from === request.nodeId || e.to === request.nodeId);
	} else if (request.op === "graph_impact" && byId.has(request.nodeId)) {
		const adjacency = new Map<string, GraphEdge[]>();
		for (const edge of edges) {
			const affectedBy = edge.kind === "imports" ? edge.to : edge.from;
			const list = adjacency.get(affectedBy) ?? [];
			list.push(edge); adjacency.set(affectedBy, list);
		}
		const queue = [request.nodeId], seen = new Set(queue), included = new Set<string>();
		nodes.set(request.nodeId, byId.get(request.nodeId)!);
		for (let i = 0; i < queue.length && !truncated; i++) {
			for (const edge of adjacency.get(queue[i]) ?? []) {
				if (included.has(edge.id)) continue;
				if (matches.length >= limit) { truncated = true; break; }
				matches.push(edge); included.add(edge.id);
				const target = edge.kind === "imports" ? edge.from : edge.to;
				if (!seen.has(target)) { seen.add(target); queue.push(target); }
			}
		}
	} else if (request.op === "graph_path" && byId.has(request.from) && byId.has(request.to)) {
		const outgoing = new Map<string, GraphEdge[]>();
		for (const edge of edges) {
			const list = outgoing.get(edge.from) ?? [];
			list.push(edge);
			outgoing.set(edge.from, list);
		}
		const queue = [request.from], prev = new Map<string, GraphEdge>();
		const seen = new Set(queue);
		for (let i = 0; i < queue.length && !seen.has(request.to); i++) {
			if (i >= 5000) { truncated = true; break; }
			for (const edge of outgoing.get(queue[i]) ?? []) {
				if (seen.has(edge.to)) continue;
				seen.add(edge.to); prev.set(edge.to, edge); queue.push(edge.to);
			}
		}
		if (seen.has(request.to)) {
			let id = request.to;
			while (id !== request.from) {
				const edge = prev.get(id)!;
				matches.push(edge); id = edge.from;
			}
			matches.reverse();
			nodes.set(request.from, byId.get(request.from)!);
			// A truncated prefix cannot answer a complete path query.
			if (matches.length > limit) { matches = []; nodes.clear(); truncated = true; }
		}
	}
	truncated ||= matches.length > limit;
	matches = matches.slice(0, limit);
	for (const edge of matches) {
		nodes.set(edge.from, byId.get(edge.from)!);
		nodes.set(edge.to, byId.get(edge.to)!);
	}
	return { nodes: [...nodes.values()], edges: matches, ...(truncated ? { truncated } : {}) };
}
