import { useEffect, useMemo, useRef, useState } from "react";
import { FiArrowRight, FiBox, FiFolder, FiGitMerge, FiRefreshCw, FiSearch, FiX } from "react-icons/fi";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { PROJECT_WORKSPACE_SELECTION_EVENT, selectProjectWorkspace, selectedProjectWorkspace } from "../project-workspaces";
import type { ClientMessage, GraphEdge, GraphNode, ProjectWorkspace, ProjectWorkspaceCatalog, WorkspaceGraphRequest, WorkspaceGraphResult } from "../types";
import { GraphDiagram, type DiagramLink, type DiagramNode } from "./GraphDiagram";

type View = Extract<WorkspaceGraphRequest, { op: "graph_search" | "graph_neighbors" | "graph_path" | "graph_impact" }>;
type Snapshot = Pick<WorkspaceGraphResult, "state" | "sources" | "publishedAt" | "error" | "version" | "freshness">;
const overview = { op: "graph_search", query: "" } as const;
const states = { not_indexed: "graphNotIndexed", building: "graphBuilding", ready: "graphReady", stale: "graphStale", updating: "graphUpdating", failed: "graphFailed" } as const;
const kinds = { module: "graphModule", repository: "graphProject", symbol: "graphSymbol" } as const;

async function requestGraph(workspaceId: string, request: WorkspaceGraphRequest, signal: AbortSignal) {
	const response = await fetch(withToken("/api/workspace-graph"), { method: "POST",
		headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, request }), signal });
	if (!response.ok) {
		const error = await response.json().catch(() => undefined);
		throw new Error(typeof error?.error === "string" ? error.error : `HTTP ${response.status}`);
	}
	const result: WorkspaceGraphResult = await response.json();
	if (result.workspaceId !== workspaceId) throw new Error("Workspace mismatch");
	return result;
}

export default function GraphWorkbench({ catalog, send, ready }: {
	catalog: ProjectWorkspaceCatalog | null;
	send: (message: ClientMessage) => boolean;
	ready: boolean;
}) {
	const t = useT();
	const [selected, setSelected] = useState(selectedProjectWorkspace);
	useEffect(() => { if (ready) send({ type: "list_project_workspaces" }); }, [send, ready]);
	useEffect(() => {
		const sync = () => setSelected(selectedProjectWorkspace());
		window.addEventListener(PROJECT_WORKSPACE_SELECTION_EVENT, sync);
		return () => window.removeEventListener(PROJECT_WORKSPACE_SELECTION_EVENT, sync);
	}, []);
	const group = catalog?.workspaces.find(entry => entry.id === selected) ?? (catalog?.workspaces.length === 1 ? catalog.workspaces[0] : undefined);
	useEffect(() => {
		if (group && selected !== group.id) selectProjectWorkspace(group.id);
	}, [group, selected]);
	return <section className="wg" aria-label={t("graphTitle")}>
		<header className="wg-heading"><FiGitMerge /><h1>{t("graphTitle")}</h1>
			{!!catalog?.workspaces.length && <select aria-label={t("graphWorkspace")} value={group?.id ?? ""} onChange={e => selectProjectWorkspace(e.target.value)}>
				{!group && <option value="">{t("graphWorkspace")}</option>}
				{catalog.workspaces.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
			</select>}
		</header>
		{!ready || !group?.paths.length ? <div className="wg-empty" role="status">{!ready ? t("graphDisconnected") : !catalog ? t("loading") : group ? t("graphEmptyGroup") : catalog.workspaces.length ? t("graphWorkspace") : t("graphNoGroup")}</div>
			: <GraphSession key={JSON.stringify([group.id, group.paths])} group={group} />}
	</section>;
}

function GraphSession({ group }: { group: ProjectWorkspace }) {
	const t = useT();
	const [status, setStatus] = useState<Snapshot>();
	const latestStatus = useRef<Snapshot>();
	const [operation, setOperation] = useState<"graph_build" | "graph_update" | "graph_status">("graph_status");
	const [refresh, setRefresh] = useState(0);
	const [generation, setGeneration] = useState(0);
	const [operationPending, setOperationPending] = useState(false);
	const [statusError, setStatusError] = useState("");
	const [queryError, setQueryError] = useState("");
	const [view, setView] = useState<View>(overview);
	const [query, setQuery] = useState("");
	const [source, setSource] = useState<string>();
	const [data, setData] = useState<WorkspaceGraphResult>();
	const [focus, setFocus] = useState<GraphNode>();
	const [origin, setOrigin] = useState<GraphNode>();
	const [selectedEdge, setSelectedEdge] = useState<string>();
	const graphReady = !!status?.version || status?.state === "ready" || status?.state === "stale";
	const detail = useRef<HTMLElement>(null);
	const busy = operationPending || status?.state === "building" || status?.state === "updating";
	useEffect(() => {
		const ctrl = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let inFlight = false;
		const inspect = async (op: typeof operation, explicit = false) => {
			if (inFlight || ctrl.signal.aborted) return;
			clearTimeout(timer);
			inFlight = true;
			let delay = 12_000;
			try {
				const result = await requestGraph(group.id, { op }, ctrl.signal);
				if (ctrl.signal.aborted) return;
				const previous = latestStatus.current;
				latestStatus.current = result;
				setStatusError("");
				setStatus(result);
				if (result.state === "building" || result.state === "updating") delay = 1200;
				if (explicit || !previous || previous.version !== result.version || previous.freshness !== result.freshness
					|| previous.state !== result.state) {
					setGeneration(n => n + 1);
				}
			} catch (error) {
				if (!ctrl.signal.aborted) setStatusError(error instanceof Error ? error.message : String(error));
			} finally {
				inFlight = false;
				if (!ctrl.signal.aborted) {
					setOperationPending(false);
					if (!document.hidden) timer = setTimeout(() => void inspect("graph_status"), delay);
				}
			}
		};
		const wake = () => {
			clearTimeout(timer);
			if (!document.hidden) void inspect("graph_status");
		};
		void inspect(operation, true);
		window.addEventListener("focus", wake);
		document.addEventListener("visibilitychange", wake);
		return () => {
			ctrl.abort();
			clearTimeout(timer);
			window.removeEventListener("focus", wake);
			document.removeEventListener("visibilitychange", wake);
		};
	}, [group.id, operation, refresh]);

	useEffect(() => {
		setData(undefined);
		setSelectedEdge(undefined);
		setQueryError("");
		if (!graphReady) return;
		const ctrl = new AbortController();
		void requestGraph(group.id, view, ctrl.signal).then(result => {
			if (ctrl.signal.aborted) return;
			setData(result);
			if (view.op === "graph_neighbors") setFocus(result.nodes.find(node => node.id === view.nodeId));
		}).catch(error => { if (!ctrl.signal.aborted) setQueryError(error.message); });
		return () => ctrl.abort();
	}, [group.id, view, graphReady, generation]);

	useEffect(() => {
		if ((focus || selectedEdge) && window.matchMedia("(max-width: 820px)").matches) detail.current?.scrollIntoView({ block: "start" });
	}, [focus, selectedEdge]);
	useEffect(() => {
		setOrigin(undefined);
		setFocus(undefined);
	}, [status?.version, status?.freshness]);

	const chooseSource = (id?: string) => {
		setSource(id);
		setQuery("");
		setFocus(undefined);
		setSelectedEdge(undefined);
		setView({ ...overview, sourceId: id });
	};
	const visit = (node: GraphNode) => {
		setFocus(node);
		setSelectedEdge(undefined);
		setView({ op: "graph_neighbors", nodeId: node.id });
	};
	const operate = (op: typeof operation) => {
		setOperation(op);
		setOperationPending(true);
		setRefresh(n => n + 1);
	};
	const index = useMemo(() => new Map(data?.nodes.map(node => [node.id, node])), [data]);
	const sourceNames = useMemo(() => new Map(status?.sources.map(item => [item.id, item.name])), [status?.sources]);
	const isOverview = view.op === "graph_search" && !view.query && !view.sourceId;
	const edges = data?.edges ?? [];
	const diagramNodes: DiagramNode[] = isOverview
		? (status?.sources ?? []).map(item => ({ id: item.id, label: item.name, caption: t("graphProject") }))
		: (data?.nodes ?? []).map(node => ({ id: node.id, label: node.label, caption: sourceNames.get(node.sourceId) ?? t(kinds[node.kind]) }));
	// A cross-project flow can have both symbol and repository projections.
	// The overview shows each proof once, favoring its repository projection.
	const crossEdges = new Map<string, GraphEdge>();
	for (const edge of isOverview ? edges : []) {
		const from = index.get(edge.from), to = index.get(edge.to);
		if (!from || !to || from.sourceId === to.sourceId) continue;
		const proof = JSON.stringify([from.sourceId, to.sourceId, edge.label, edge.anchors]);
		if (from.kind === "repository" || !crossEdges.has(proof)) crossEdges.set(proof, edge);
	}
	const shownEdges = isOverview ? [...crossEdges.values()] : edges;
	const pairs = new Map<string, DiagramLink>();
	for (const edge of shownEdges) {
		const from = isOverview ? index.get(edge.from)!.sourceId : edge.from;
		const to = isOverview ? index.get(edge.to)!.sourceId : edge.to;
		const pair = JSON.stringify([from, to]);
		if (!pairs.has(pair)) pairs.set(pair, { id: edge.id, from, to });
	}
	const edge = edges.find(item => item.id === selectedEdge);
	const heading = isOverview ? t("graphOverview") : view.op === "graph_neighbors" ? t("graphNeighbors")
		: view.op === "graph_impact" ? t("graphImpact") : view.op === "graph_path" ? t("graphPath") : view.query ? t("graphResult") : sourceNames.get(source ?? "") ?? t("graphNodes");
	return <div className="wg-body">
		<aside className="wg-nav">
			<form className="wg-search" onSubmit={event => {
				event.preventDefault();
				setFocus(undefined);
				setView({ op: "graph_search", query: query.trim(), sourceId: source });
			}}>
				<input maxLength={256} aria-label={t("graphSearch")} placeholder={t("graphSearch")} value={query} onChange={e => setQuery(e.target.value)} disabled={!graphReady} />
				<button type="submit" aria-label={t("graphSearchGo")} disabled={!graphReady}><FiSearch /></button>
			</form>
			<h2>{t("graphProjects")}</h2>
			<button className="wg-source" aria-pressed={isOverview} onClick={() => chooseSource()}><FiGitMerge />{t("graphOverview")}</button>
			{(status?.sources ?? []).map(item => <button key={item.id} title={item.name} className="wg-source"
				aria-pressed={source === item.id} onClick={() => chooseSource(item.id)}><FiFolder /><span>{item.name}</span></button>)}
		</aside>
		<main className="wg-main">
			<div className="wg-tools" aria-label={t("graphControls")}>
				<span className="wg-state" role="status">{status ? t(states[status.state]) : t("loading")}</span>
				{status?.publishedAt && <time title={t("graphUpdated") + " · " + new Date(status.publishedAt).toLocaleString()}>{new Date(status.publishedAt).toLocaleTimeString()}</time>}
				{status && <button className="wg-primary" disabled={busy} onClick={() => operate(status.state === "not_indexed" || status.state === "failed" ? "graph_build" : "graph_update")}>
					{status.state === "not_indexed" || status.state === "failed" ? t("graphBuild") : t("graphUpdate")}</button>}
				{graphReady && <button disabled={busy} onClick={() => operate("graph_build")}>{t("graphRebuild")}</button>}
				<button title={t("graphRefresh")} aria-label={t("graphRefresh")} disabled={operationPending} onClick={() => operate("graph_status")}><FiRefreshCw /></button>
			</div>
			{(statusError || status?.error || queryError) && <p role="alert" className="wg-error">{statusError || queryError || status?.error}</p>}
			<h2>{heading}</h2>
			{origin && <div className="wg-path-start">{t("graphOrigin")} · {origin.label}<button onClick={() => setOrigin(undefined)} aria-label={t("graphCancelPath")}><FiX /></button></div>}
			{!data ? <p className="wg-hint">{status?.state === "not_indexed" ? t("graphPending") : !queryError && !statusError && (busy || graphReady) ? t("loading") : ""}</p> : <>
				{diagramNodes.length > 0 && <GraphDiagram nodes={diagramNodes} links={[...pairs.values()]} onEdge={setSelectedEdge} onNode={id => {
					if (isOverview) chooseSource(id);
					else { const node = index.get(id); if (node) visit(node); }
				}} />}
				{data.truncated && <p className="wg-hint">{t("graphLimited")}</p>}
				{!isOverview && <details className="wg-node-list" open={view.op === "graph_search" && !edges.length}>
					<summary>{t("graphNodes")} · {data.nodes.length}</summary>
					{data.nodes.map(node => <button key={node.id} onClick={() => visit(node)}><FiBox />{node.label}<small>{t(kinds[node.kind])}</small></button>)}
				</details>}
				<h3>{t("graphRelations")} · {shownEdges.length}</h3>
				{shownEdges.length ? <div className="wg-relations">{shownEdges.map(rel => <button key={rel.id} aria-pressed={edge?.id === rel.id} onClick={() => setSelectedEdge(rel.id)}>
					<span>{index.get(rel.from)?.label ?? rel.from}</span><FiArrowRight /><span>{index.get(rel.to)?.label ?? rel.to}</span><small>{rel.label}</small>
				</button>)}</div> : <p className="wg-hint">{t(view.op === "graph_path" ? "graphNoPath" : isOverview ? "graphNoCross" : !index.size ? "graphNoResult" : "graphNoEdges")}</p>}
			</>}
		</main>
		<aside ref={detail} className="wg-detail"><h2>{t("graphEvidence")}</h2>
			{edge && data ? <GraphEvidence key={JSON.stringify([edge.id, data.version])} workspaceId={group.id} edge={edge} sourceNames={sourceNames} />
				: focus ? <div className="wg-node-detail"><small>{t(kinds[focus.kind])} · {sourceNames.get(focus.sourceId)}</small><h3>{focus.label}</h3>
					{focus.anchor && <code>{focus.anchor.path}:{focus.anchor.line}</code>}
					<button onClick={() => setView({ op: "graph_impact", nodeId: focus.id })}>{t("graphImpact")}</button>
					<button onClick={() => setOrigin(focus)}>{t("graphSetOrigin")}</button>
					{origin && origin.id !== focus.id && <button onClick={() => setView({ op: "graph_path", from: origin.id, to: focus.id })}>{t("graphFindPath")}</button>}
				</div> : <p className="wg-hint">{t("graphSelectEdge")}</p>}
			<DocumentReview key={JSON.stringify([refresh, generation])} workspaceId={group.id} sourceNames={sourceNames} onNode={id => {
				setSelectedEdge(undefined);
				setFocus(undefined);
				setView({ op: "graph_neighbors", nodeId: id });
			}} />
		</aside>
	</div>;
}

function GraphEvidence({ workspaceId, edge, sourceNames }: { workspaceId: string; edge: GraphEdge; sourceNames: Map<string, string> }) {
	const t = useT();
	const [anchor, setAnchor] = useState(0);
	return <div className="wg-evidence"><h3>{edge.label}</h3>
		{!edge.anchors.length ? <p>{t("graphMissingAnchors")}</p> : <>
			{edge.anchors.length > 2 && <select aria-label={t("graphAnchor")} value={anchor} onChange={event => setAnchor(Number(event.target.value))}>
				{edge.anchors.slice(0, -1).map((a, i) => <option key={i} value={i}>{sourceNames.get(a.sourceId)} · {a.path}:{a.line}</option>)}
			</select>}
			{Array.from(new Set([anchor, edge.anchors.length - 1])).map(i => <SourceExcerpt key={i}
				workspaceId={workspaceId} edge={edge} index={i} source={sourceNames.get(edge.anchors[i].sourceId) ?? edge.anchors[i].sourceId} />)}
		</>}
	</div>;
}

function SourceExcerpt({ workspaceId, edge, index, source }: { workspaceId: string; edge: GraphEdge; index: number; source: string }) {
	const t = useT();
	const [snippet, setSnippet] = useState<WorkspaceGraphResult["evidence"]>();
	const [error, setError] = useState("");
	const [retry, setRetry] = useState(0);
	const anchor = edge.anchors[index];
	useEffect(() => {
		const ctrl = new AbortController();
		setError("");
		setSnippet(undefined);
		void requestGraph(workspaceId, { op: "graph_evidence", edgeId: edge.id, anchor: index }, ctrl.signal).then(result => {
			if (ctrl.signal.aborted) return;
			if (!result.evidence) throw new Error(result.error || t("graphRequestFailed"));
			const found = result.evidence.anchor;
			if (found.sourceId !== anchor.sourceId || found.path !== anchor.path || found.line !== anchor.line
				|| found.endLine !== anchor.endLine || found.sha256 !== anchor.sha256) throw new Error(t("graphEvidenceChanged"));
			setSnippet(result.evidence);
		}).catch(err => { if (!ctrl.signal.aborted) setError(err.message); });
		return () => ctrl.abort();
	}, [workspaceId, edge.id, index, anchor.sourceId, anchor.path, anchor.line, anchor.endLine, anchor.sha256, retry, t]);
	return <section className="wg-excerpt">
		<b>{source}</b><code>{anchor.path}:{anchor.line}</code>
		{error ? <div role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>{t("retry")}</button></div> : !snippet ? <small>{t("loading")}</small>
			: <pre tabIndex={0}>{snippet.lines.map((line, i) => {
				const no = snippet.firstLine + i;
				return <span key={no} className={no >= anchor.line && no <= anchor.endLine ? "wg-highlight" : ""}><i>{no}</i>{line || " "}</span>;
			})}</pre>}
	</section>;
}

function DocumentReview({ workspaceId, sourceNames, onNode }: { workspaceId: string; sourceNames: Map<string, string>; onNode: (id: string) => void }) {
	const t = useT();
	const [path, setPath] = useState("");
	const [submitted, setSubmitted] = useState<{ path: string }>();
	const [review, setReview] = useState<WorkspaceGraphResult["review"]>();
	const [checkedAt, setCheckedAt] = useState<Date>();
	const [error, setError] = useState("");
	const labels = { verified: "graphVerified", stale: "graphOutdated", unavailable: "graphUnavailable", unverified: "graphUnverified" } as const;
	useEffect(() => {
		setReview(undefined);
		setCheckedAt(undefined);
		setError("");
		if (!submitted) return;
		const ctrl = new AbortController();
		void requestGraph(workspaceId, { op: "graph_document", path: submitted.path }, ctrl.signal).then(result => {
			if (ctrl.signal.aborted) return;
			if (!result.review) throw new Error(result.error || t("graphRequestFailed"));
			setReview(result.review);
			setCheckedAt(new Date());
		}).catch(err => { if (!ctrl.signal.aborted) setError(err.message); });
		return () => ctrl.abort();
	}, [workspaceId, submitted, t]);
	return <details className="wg-doc-review"><summary>{t("graphDocReview")}</summary>
		<form onSubmit={event => { event.preventDefault(); if (path.trim()) setSubmitted({ path: path.trim() }); }}>
			<label>{t("graphDocPath")}<input type="text" value={path} placeholder="docs/design.md" maxLength={1024} onChange={event => { setPath(event.target.value); setSubmitted(undefined); }} /></label>
			<button disabled={!path.trim()}>{t(review ? "graphDocRecheck" : "graphDocInspect")}</button>
		</form>
		{error && <p role="alert">{error}</p>}
		{submitted && !review && !error && <p role="status">{t("loading")}</p>}
		{review && <div className="wg-doc-refs">
			<strong>{review.path}</strong>
			{checkedAt && <time dateTime={checkedAt.toISOString()}>{t("graphDocChecked")} · {checkedAt.toLocaleString()}</time>}
			{review.references.length === 0 && <p>{t("graphNoReferences")}</p>}
			{review.references.map((ref, i) => <div key={i}>
				<b>{t(labels[ref.state])}</b>
				{ref.state !== "unavailable" && ref.path && <code>{ref.sourceId && (sourceNames.get(ref.sourceId) ?? ref.sourceId) + " / "}{ref.path}{ref.line && ":" + ref.line}{ref.endLine && ref.endLine !== ref.line && "–" + ref.endLine}</code>}
				{ref.state !== "unavailable" && ref.nodeId && <button onClick={() => onNode(ref.nodeId!)}>{t("graphLocate")}</button>}
			</div>)}
			{review.truncated && <p>{t("graphLimited")}</p>}
		</div>}
	</details>;
}
