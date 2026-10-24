import { copyText } from "../clipboard";
import { FolderPickerModal } from "./FolderPickerModal";
import { FiTerminal, FiFolder, FiPlus, FiArrowRight, FiSearch, FiX, FiEye, FiEyeOff } from "react-icons/fi";
import { useDialogFocus } from "../use-dialog-focus";
import { NodeAgentPanel } from "./NodeAgentPanel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";
import { RemoteTerminal } from "./node-terminal";

import type { NodeAgentState, NodeProfile, NodeSource,   ClientMessage, ServerMessage, DirBrowse } from "../types";

type Event = Extract<ServerMessage, { type: "node_event" }>;
type Node = NodeProfile;
type Tab = { id: string; conversationId: string; busy: boolean; closed?: boolean; output?: string };

const draftNode = (): Partial<Node> => ({ name: "", group: "默认", host: "", port: 22, username: "root", auth: "password", defaultDir: "/" });

export function NodeWorkbench({ send, active, dirBrowse }: { send: (msg: ClientMessage) => boolean; active: boolean; dirBrowse: DirBrowse | null }) {
	const t = useT();
	const [sources, setSources] = useState<NodeSource[]>([]);
	const [detected, setDetected] = useState<Partial<NodeSource>[]>([]);
	const [sourceView, setSourceView] = useState(false);
	const [sourceSync, setSourceSync] = useState(true);
	const [detectedDone, setDetectedDone] = useState(false);
	const [sourceDraft, setSourceDraft] = useState<{ kind: "xshell" | "ssh"; path: string } | null>(null);
	const [manageOpen, setManageOpen] = useState(false);
	const [browseSource, setBrowseSource] = useState(false);
	const [preview, setPreview] = useState<(Omit<Node, "id"> & { sourceKey: string })[] | null>(null);
	const [chosenKeys, setChosenKeys] = useState<string[]>([]);
	const [previewError, setPreviewError] = useState("");
	const [sourceBusy, setSourceBusy] = useState(false);
	const previewRequest = useRef<string | null>(null);
	const sourceRequest = useRef<string | null>(null);
	const saveRequest = useRef<string | null>(null);
	const [saveBusy, setSaveBusy] = useState(false);
	const [showSecret, setShowSecret] = useState(false);

	const [search, setSearch] = useState("");
	const [workspace, setWorkspace] = useState(false);
	const [showFiles, setShowFiles] = useState(false);
	const [agentDrafts, setAgentDrafts] = useState<Record<string, string>>({});
	const consumedAgentEditors = useRef<Record<string, string>>({});
	const [agents, setAgents] = useState<Record<string, NodeAgentState>>({});

	const [credentialAuth, setCredentialAuth] = useState<"password" | "key">("password");
	const [credentialKeyPath, setCredentialKeyPath] = useState("");
	const [credential, setCredential] = useState<string | null>(null);
	const [persistSecret, setPersistSecret] = useState(true);
	const [sameGroup, setSameGroup] = useState(false);
	const [testing, setTesting] = useState(false);
	const credentialAttempt = useRef<{ nodeId: string; payload: Record<string, unknown> } | null>(null);
	const opening = useRef(new Set<string>());
	const awaitingTrust = useRef(new Set<string>());
	const [notice, setNotice] = useState("");
	const [nodes, setNodes] = useState<Node[]>([]);
	const [timings, setTimings] = useState<Record<string, { connectedAt?: number; latencyMs?: number }>>({});
	const [now, setNow] = useState(Date.now());
	const [connections, setConnections] = useState<Record<string, string>>({});
	const [tabs, setTabs] = useState<Record<string, Tab[]>>({});
	const [selected, setSelected] = useState<string>(localStorage.getItem("pi-node-selected") ?? "");
	const [activeTabs, setActiveTabs] = useState<Record<string, string>>({});

	const [draft, setDraft] = useState<Partial<Node> | null>(null);
	const [secret, setSecret] = useState("");
	const [error, setError] = useState("");

	const [path, setPath] = useState("/");
	const [listings, setListings] = useState<Record<string, { path: string; entries: { name: string; type: string }[] }>>({});
	const [file, setFile] = useState<{ nodeId: string; path: string; text: string } | null>(null);
	const terminalHistory = useRef(new Map<string, string>());
	const latestList = useRef(new Map<string, string>());
	const latestRead = useRef(new Map<string, string>());
	const pendingWrite = useRef<string | null>(null);
	const request = useCallback((action: string, nodeId?: string, payload?: Record<string, unknown>, terminalId?: string, conversationId?: string) => {
		const requestId = randomUuid();
		return send({ type: "node_request", requestId, action, nodeId, terminalId, conversationId, payload }) ? requestId : null;
	}, [send]);
	useEffect(() => {
		setPreview(null); setChosenKeys([]); setPreviewError(""); previewRequest.current = null;
		if (!sourceDraft?.path.trim()) return;
		const timer = setTimeout(() => { previewRequest.current = request("source_preview", undefined, sourceDraft); }, 300);
		return () => { clearTimeout(timer); previewRequest.current = null; };
	}, [sourceDraft?.kind, sourceDraft?.path, request]);

	useEffect(() => { if (!active || !workspace) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active, workspace]);
	const node = nodes.find((n) => n.id === selected);
	const currentTabs = tabs[selected] ?? [];
	const activeTab = currentTabs.find((t) => t.id === activeTabs[selected]) ?? currentTabs.at(-1);

	const credentialNode = nodes.find((n) => n.id === credential);
	const sourceDialogRef = useDialogFocus<HTMLFormElement>(!!sourceDraft);
	const credentialDialogRef = useDialogFocus<HTMLFormElement>(!!credentialNode);
	const nodeDialogRef = useDialogFocus<HTMLFormElement>(!!draft);
	const source = sources.find((s) => s.id === node?.sourceId);
	const entries = listings[selected]?.path === path ? listings[selected].entries : [];

	useEffect(() => { if (active) { request("state"); request("source_detect"); } }, [active, request]);

	useEffect(() => { if (node) setPath(node.defaultDir); }, [selected, node?.defaultDir]);
	useEffect(() => {
		const listener = (e: globalThis.Event) => {
			const msg = (e as CustomEvent<Event>).detail;
			const id = msg.nodeId ?? "";

			if (msg.event === "state") {
				const list = (msg.data?.nodes ?? []) as Node[];
				setNodes(list);
				setAgents(before => {
					const next: Record<string, NodeAgentState> = Object.fromEntries(Object.entries(before).map(([key, state]) => [key, { ...state, phase: "closed" as const, running: false, dialogs: [] }]));
					for (const connection of (msg.data?.connections ?? []) as { nodeId: string; agent?: NodeAgentState }[]) if (connection.agent) next[connection.nodeId] = connection.agent;
					for (const key of Object.keys(next)) if (!list.some(node => node.id === key)) delete next[key];
					return next;
				});
				setTimings(Object.fromEntries(((msg.data?.connections ?? []) as { nodeId: string; connectedAt?: number; latencyMs?: number }[]).map((c) => [c.nodeId, c])));
				setSources((msg.data?.sources ?? []) as NodeSource[]);

				setConnections(Object.fromEntries(((msg.data?.connections ?? []) as { nodeId: string; status: string }[]).map((c) => [c.nodeId, c.status])));
				for (const c of (msg.data?.connections ?? []) as { nodeId: string; terminals: Tab[] }[]) for (const tab of c.terminals) terminalHistory.current.set(`${c.nodeId}:${tab.id}`, tab.output ?? "");
				setTabs((before) => {
					const next = { ...before };
					for (const c of (msg.data?.connections ?? []) as { nodeId: string; terminals: Tab[] }[]) {
						const previous = (before[c.nodeId] ?? []).filter((tab) => !c.terminals.some((current) => current.id === tab.id)).map((tab) => ({ ...tab, closed: true }));
						next[c.nodeId] = [...previous, ...c.terminals];
					}
					for (const key of Object.keys(next)) if (!((msg.data?.connections ?? []) as { nodeId: string }[]).some((c) => c.nodeId === key)) next[key] = next[key].map((t) => ({ ...t, closed: true }));
					for (const key of Object.keys(next)) if (!list.some((n) => n.id === key)) delete next[key];
					return next;
				});
				return;
			}
			if (msg.event === "agent_state" && msg.data?.agent) { const agent = msg.data.agent as NodeAgentState; setAgents(all => ({ ...all, [id]: agent })); return; }
			if (msg.event === "terminal_output") {
				const key = `${id}:${msg.terminalId}`;
				terminalHistory.current.set(key, ((terminalHistory.current.get(key) ?? "") + String(msg.data?.text ?? "")).slice(-65536));
				return;
			}
			if (msg.event === "trust_required") {
				if (msg.requestId) awaitingTrust.current.add(msg.requestId);
				if (window.confirm(t("nodeTrust", { name: String(msg.data?.name ?? ""), host: String(msg.data?.host ?? ""), fingerprint: String(msg.data?.fingerprint ?? "") }))) {
					const attempt = credentialAttempt.current;
					if (attempt?.nodeId === id) request("credential_test", id, { ...attempt.payload, fingerprint: msg.data?.fingerprint });
					else request("trust", id, { fingerprint: msg.data?.fingerprint });
				} else { opening.current.delete(id); credentialAttempt.current = null; setTesting(false); }
				return;
			}

			if (msg.event === "failure" && String(msg.data?.action ?? "").startsWith("agent_")) return;
			if (msg.event === "failure" && msg.data?.action === "source_preview") { if (msg.requestId === previewRequest.current) { setPreviewError(String(msg.data?.message ?? "")); setPreview(null); } return; }
			if (msg.event === "failure" && msg.requestId === sourceRequest.current) { setSourceBusy(false); setPreviewError(String(msg.data?.message ?? "")); return; }
			if (msg.event === "failure" && msg.data?.action === "save") setSaveBusy(false);
			if (msg.event === "failure") { if (msg.requestId === pendingWrite.current) pendingWrite.current = null; const text = String(msg.data?.message ?? "");
				if (!(msg.requestId && awaitingTrust.current.delete(msg.requestId))) { setError(text); setTesting(false); if (msg.data?.action === "credential_test") credentialAttempt.current = null; opening.current.delete(id); }
				return; }

			if (msg.event === "terminal_welcome") { setTabs(all => ({ ...all, [id]: (all[id] ?? []).map(tab => tab.id === msg.terminalId ? { ...tab, welcome: String(msg.data?.text ?? "") } : tab) })); return; }
			if (msg.event === "terminal_busy") { setTabs((all) => ({ ...all, [id]: (all[id] ?? []).map((t) => t.id === msg.terminalId ? { ...t, busy: Boolean(msg.data?.busy) } : t) })); return; }
			if (msg.event === "terminal_exit") { const key = `${id}:${msg.terminalId}`; terminalHistory.current.set(key, (terminalHistory.current.get(key) ?? "") + "\r\n[SSH 已断开]\r\n"); setTabs((all) => ({ ...all, [id]: (all[id] ?? []).map((t) => t.id === msg.terminalId ? { ...t, closed: true } : t) })); return; }
			if (msg.event !== "result") return;
			const action = msg.data?.action;
			if (action === "source_detect") { setDetected((msg.data?.sources ?? []) as Partial<NodeSource>[]); setDetectedDone(true); }
			if (action === "source_preview" && msg.requestId === previewRequest.current) { const list = (msg.data?.nodes ?? []) as (Omit<Node, "id"> & { sourceKey: string })[]; setPreview(list); setChosenKeys(list.filter(n => !n.unsupported?.some(reason => reason !== "key")).map(n => n.sourceKey)); }
			if (action === "source_add" && msg.requestId === sourceRequest.current) { setSourceBusy(false); setSourceDraft(null); setSourceView(false); }
			if (action === "credential_test") { credentialAttempt.current = null; setTesting(false); setCredential(null); setSecret(""); setNotice(t("nodeCredentialsSaved", { n: Number(msg.data?.count ?? 1) })); }
			if ((action === "connect" || action === "trust" || action === "credential_test") && opening.current.has(id)) { opening.current.delete(id); request("terminal_open", id, {}, randomUuid()); setWorkspace(true); }
			if (action === "terminal_open") { const t: Tab = { id: String(msg.data?.terminalId), conversationId: String(msg.data?.conversationId), busy: false }; setTabs((all) => ({ ...all, [id]: (all[id] ?? []).some((x) => x.id === t.id) ? all[id] : [...(all[id] ?? []), t] })); setActiveTabs((all) => ({ ...all, [id]: t.id })); }
			if (action === "list" && msg.requestId === latestList.current.get(id)) setListings((all) => ({ ...all, [id]: { path: String(msg.data?.path ?? ""), entries: (msg.data?.entries ?? []) as { name: string; type: string }[] } }));
			if (action === "read" && msg.requestId === latestRead.current.get(id)) setFile({ nodeId: id, path: String(msg.data?.path ?? ""), text: String(msg.data?.text ?? "") });
			if (action === "write" && msg.requestId === pendingWrite.current) { pendingWrite.current = null; setFile((current) => current?.nodeId === id && current.path === msg.data?.path ? null : current); }

			if (action === "save") { setSaveBusy(false); setDraft(null); setSecret(""); if (msg.data?.id) { const savedId = String(msg.data.id); setSelected(savedId); setSourceView(false); if (msg.requestId === saveRequest.current) { saveRequest.current = null; opening.current.add(savedId); setWorkspace(true); request("connect", savedId); } } }
			if (action === "import_legacy" || action === "import") setNotice(t("nodeImported", { n: Number(msg.data?.count ?? 0) }));
		};
		window.addEventListener("pi-node-event", listener);
		return () => window.removeEventListener("pi-node-event", listener);
	}, [request, t]);
	const filtered = useMemo(() => nodes.filter((n) => `${n.name} ${n.host} ${n.username}`.toLowerCase().includes(search.toLowerCase())), [nodes, search]);
	const groups = useMemo(() => [...new Set(filtered.map((n) => n.group))], [filtered]);
	const listFiles = (target: string) => { const id = request("list", selected, { path: target }, activeTab?.id, activeTab?.conversationId); if (id) latestList.current.set(selected, id); };
	const openFile = (target: string) => { const id = request("read", selected, { path: target }, activeTab?.id, activeTab?.conversationId); if (id) latestRead.current.set(selected, id); };
	const saveFile = () => { if (!file || file.nodeId !== selected) return; pendingWrite.current = request("write", file.nodeId, { path: file.path, text: file.text }, activeTab?.id, activeTab?.conversationId); };

	const openNode = (target: Node) => {
		setSelected(target.id); setError("");
		if ((target.auth === "password" && !target.hasSecret) || (target.auth === "key" && (!target.keyPath || target.unsupported?.includes("key")) && !target.localKeyPath)) { setCredentialAuth(target.auth === "key" ? "key" : "password"); setCredentialKeyPath(target.localKeyPath || target.keyPath || ""); setCredential(target.id); setSecret(""); setSameGroup(false); opening.current.add(target.id); return; }
		setWorkspace(true); setSourceView(false);
		if (connections[target.id] === "connected") { if (!(tabs[target.id] ?? []).some((tab) => !tab.closed)) request("terminal_open", target.id, {}, randomUuid()); }
		else { opening.current.add(target.id); request("connect", target.id); }
	};

	const addButton = <button onClick={() => setSourceView(true)} aria-label={t("nodeAdd")} title={t("nodeAdd")}><FiPlus aria-hidden="true" /></button>;
	const importButton = <label className="node-secondary">{t("nodeImportJson")}<input type="file" accept="application/json,.json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { const data = JSON.parse(await f.text()); request("import", undefined, { nodes: data.nodes }); } catch { setError(t("nodeInvalidJson")); } e.target.value = ""; }} /></label>;
	const sourceCards = <div className={`node-source-page node-simple-start ${manageOpen ? "managing" : ""}`}>
		<h2>{t("nodeAdd")}</h2><p className="node-muted">{t("nodeSimpleIntro")}</p>
		<div className="node-entry-options">
			<button onClick={() => { setDraft(draftNode()); setSecret(""); }}><FiTerminal aria-hidden="true" /><FiArrowRight className="node-entry-arrow" aria-hidden="true" /><strong>{t("nodeSshEntry")}</strong><span>{t("nodeSshHint")}</span></button>
			<button onClick={() => { setSourceSync(true); setSourceDraft({ kind: "xshell", path: detected.find(s => s.kind === "xshell")?.path ?? "" }); }}><FiFolder aria-hidden="true" /><FiArrowRight className="node-entry-arrow" aria-hidden="true" /><strong>{t("nodeXshellEntry")}</strong><span>{t("nodeXshellHint")}</span></button>
		</div>
		<details className="node-advanced" open={manageOpen}><summary onClick={e => { e.preventDefault(); setManageOpen(!manageOpen); }}>{t("nodeSourceManage")}{sources.length > 0 && ` · ${sources.length}`}</summary>
		{detectedDone && !detected.length && !sources.length && <p className="node-muted">{t("nodeNoSources")}</p>}
		{[...sources, ...detected.filter(d => !sources.some(s => s.path === d.path))].map(s => <section className="node-source-card" key={s.path}>
			<header><strong>{s.kind === "xshell" ? "Xshell" : "SSH config"}</strong><small>{t("nodeSyncInfo", { n: s.count ?? 0, g: s.groups ?? 0 })}</small>{s.id && <span className={`node-sync-badge ${s.error ? "error" : s.enabled ? "enabled" : ""}`}>{t(s.error ? "nodeSyncFailed" : s.enabled ? "nodeSyncActive" : "nodeSyncPaused")}</span>}</header><code>{s.path}</code>
			{s.error && <p className="node-error" role="alert">{s.error}</p>}
			<div className="node-actions">{s.id ? <><button onClick={() => request("source_sync", undefined, { id: s.id })}>{t("nodeSyncNow")}</button><button onClick={() => request("source_toggle", undefined, { id: s.id, enabled: !s.enabled })}>{t(s.enabled ? "nodeSyncPause" : "nodeSyncResume")}</button></> : <button onClick={() => { setSourceSync(true); setSourceDraft({ kind: s.kind ?? "ssh", path: s.path ?? "" }); }}>{t("nodeAddSource")}</button>}</div>
		</section>)}
		<div className="node-actions"><button onClick={() => { setSourceSync(true); setSourceDraft({ kind: "ssh", path: detected.find(s => s.kind === "ssh")?.path ?? "" }); }}>{t("nodeSshConfig")}</button><button onClick={() => request("source_detect")}>{t("nodeDetect")}</button>{importButton}</div>
		</details>
	</div>;
	return <div className={`node-workbench node-agent-open ${workspace && node ? "node-workspace-open" : ""}`}>
		{error && <div className="node-global-message node-error" role="alert">{error}<button aria-label={t("close")} onClick={() => setError("")}>×</button></div>}
		{notice && <div className="node-global-message node-notice" role="status">{notice}<button aria-label={t("close")} onClick={() => setNotice("")}>×</button></div>}
		{!workspace && <aside className="node-sidebar"><header><strong>{t("nodeWorkbench")}</strong>{addButton}</header><div className="node-search-field"><FiSearch aria-hidden="true" /><input aria-label={t("nodeSearch")} placeholder={t("nodeSearch")} value={search} onChange={(e) => setSearch(e.target.value)} /></div>
			{sources.map((s) => <button className={`node-source-status ${s.enabled && !s.error ? "enabled" : ""}`} key={s.id} onClick={() => { setSourceView(true); setManageOpen(true); }}><span className={`node-dot ${s.error ? "connecting" : s.enabled ? "connected" : "offline"}`} />{s.kind === "xshell" ? "Xshell" : "SSH config"}<small>{s.error || (s.lastSync ? new Date(s.lastSync).toLocaleTimeString() : "…")}</small></button>)}
			<div className="node-list">{!filtered.length && <p className="node-list-empty" role="status">{t(search.trim() ? "nodeSearchEmpty" : "nodeListEmpty")}</p>}{groups.map((group) => <section key={group}><h3>{group}<span>{filtered.filter((n) => n.group === group).length}</span></h3>{filtered.filter((n) => n.group === group).map((n) => <div className={`node-item ${selected === n.id ? "selected" : ""}`} key={n.id}><button aria-current={selected === n.id && !sourceView ? "true" : undefined} title={`${n.name} · ${n.username}@${n.host}:${n.port}`} onClick={() => { setSelected(n.id); setSourceView(false); }}><span className={`node-dot ${connections[n.id] ?? "offline"}`} />{n.name}<small>{n.username}@{n.host}:{n.port}</small></button>{(n.sourceMissing || n.unsupported?.length || n.auth === "password" && !n.hasSecret) && <span className="node-badge">{t(n.sourceMissing ? "nodeSourceMissing" : n.unsupported?.length ? "nodeUnsupported" : "nodeMissingSecret")}</span>}{!n.sourceId && <button title={t("nodeEdit")} onClick={() => { setDraft(n); setSecret(""); }}>⋯</button>}</div>)}</section>)}</div>
			<footer><button onClick={() => { setSourceView(true); setManageOpen(true); }}>{t("nodeSourceManage")}</button><details><summary aria-label={t("nodeMoreActions")}>⋯</summary>{importButton}<button onClick={() => request("import_legacy")}>{t("nodeImportLegacy")}</button><button onClick={() => { const clean = nodes.map(({ hasSecret, fingerprint, sourceId, sourceKey, sourceMissing, ...rest }) => rest); const url = URL.createObjectURL(new Blob([JSON.stringify({ nodes: clean }, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "pi-nodes.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>{t("nodeExport")}</button></details></footer>
		</aside>}
		{!workspace && (sourceView || !node ? sourceCards : <section className="node-detail">
			<header className="node-detail-head"><div><div className="node-eyebrow">{node.group}</div><h2>{node.name}</h2><code>{node.username}@{node.host}:{node.port}</code></div><div className="node-actions"><button className="node-primary" disabled={!!node.unsupported?.some((reason) => reason !== "key") || node.sourceMissing || connections[node.id] === "connecting"} onClick={() => openNode(node)}>{t("nodeOpenWorkbench")}</button></div></header>
			<div className="node-detail-summary"><div><span>{t("nodeConnectionStatus")}</span><strong><i className={`node-dot ${connections[node.id] ?? "offline"}`} />{t(connections[node.id] === "connected" ? "nodeConnected" : connections[node.id] === "connecting" ? "nodeConnecting" : "nodeDisconnected")}</strong></div><div><span>{t("nodeAuth")}</span><strong>{t(node.auth === "key" ? "nodeKey" : node.auth === "agent" ? "nodeAgentAuth" : "nodePassword")}</strong></div><div><span>{t("nodeDefaultDir")}</span><code>{node.defaultDir}</code></div></div>
			{node.sourceMissing && <p className="node-warning">{t("nodeSourceMissing")}</p>}{!!node.unsupported?.length && <p className="node-warning">{t("nodeUnsupported")}: {node.unsupported.join(", ")}</p>}
			<details className="node-advanced" key={node.id}><summary>{t("nodeConnectionSettings")}</summary><div className="node-actions">{source && <button onClick={() => request("source_reveal", undefined, { id: source.id })}>{t("nodeRevealSource")}</button>}{!node.sourceId && <button onClick={() => { setDraft(node); setSecret(""); }}>{t("nodeEdit")}</button>}</div>
			{<div className={node.hasSecret ? "node-credential-note" : "node-warning"}><div><strong>{t(node.auth === "agent" ? "nodeAgentAuth" : node.auth === "password" ? "nodePassword" : "nodePassphrase")}{!node.hasSecret && node.auth === "password" && ` · ${t("nodeMissingSecret")}`}</strong><p>{t("nodeCredentialHint")}</p></div><button onClick={() => { setCredentialAuth(node.auth === "key" ? "key" : "password"); setCredentialKeyPath(node.localKeyPath || node.keyPath || ""); setCredential(node.id); setSecret(""); setSameGroup(false); }}>{t("nodeFillSecret")}</button></div>}
			<dl><dt>{t("nodeAuth")}</dt><dd>{t(node.auth === "key" ? "nodeKey" : node.auth === "agent" ? "nodeAgentAuth" : "nodePassword")}</dd>{(node.localKeyPath || node.keyPath) && <><dt>{t("nodeKeyPath")}</dt><dd><code>{node.localKeyPath || node.keyPath}</code></dd></>}{source && <><dt>{t("nodeSourceLocation")}</dt><dd><code>{source.path}{source.kind === "xshell" ? `/${node.sourceKey}` : ` · ${node.sourceKey}`}</code><small>{t("nodeSourceReadonly")}</small><button title={t("nodeSourceOpenHint")} onClick={event => void copyText(source.kind === "xshell" ? `${source.path}/${node.sourceKey}` : source.path, event.currentTarget.ownerDocument).then(() => setNotice(t("nodeCopied"))).catch((e) => setError(String(e)))}>{t("nodeCopy")}</button></dd></>}<dt>{t("nodeLastConnected")}</dt><dd>{node.lastConnected ? new Date(node.lastConnected).toLocaleString() : t("nodeNever")}</dd><dt>{t("nodeDefaultDir")}</dt><dd><code>{node.defaultDir}</code></dd></dl>
			</details>

		</section>)}
		{workspace && node && <div className="node-connected"><nav className="node-connection-tabs"><button onClick={() => setWorkspace(false)}>{t("nodeBackList")}</button>{nodes.filter((n) => n.id === selected || connections[n.id] || tabs[n.id]?.length).map((n) => <button key={n.id} className={n.id === selected ? "active" : ""} onClick={() => setSelected(n.id)}><span className={`node-dot ${connections[n.id] ?? "offline"}`} />{n.name}</button>)}<button onClick={() => { setWorkspace(false); setSourceView(true); }} aria-label={t("nodeAdd")}>＋</button><span className="node-connection-address">{node.username}@{node.host}:{node.port}</span>{timings[selected]?.connectedAt && <span className="node-connection-timing">{t("nodeConnectionTiming", { ms: timings[selected].latencyMs ?? 0, duration: `${Math.floor(Math.max(0, now - timings[selected].connectedAt!) / 60000)}:${String(Math.floor(Math.max(0, now - timings[selected].connectedAt!) / 1000) % 60).padStart(2, "0")}` })}</span>}<button onClick={() => connections[selected] === "connected" ? request("disconnect", selected) : openNode(node)}>{t(connections[selected] === "connected" ? "nodeDisconnect" : "nodeConnect")}</button></nav>
			<div className="node-connected-body"><section className="node-main">
			<div className="node-workspace-split"><div className="node-manual-workbench">
			<div className="node-tabs">{currentTabs.map((tab, i) => <div key={tab.id} className={activeTab?.id === tab.id ? "active" : ""}><button onClick={() => { setActiveTabs((a) => ({ ...a, [selected]: tab.id })); request("terminal_select", selected, {}, tab.id, tab.conversationId); }}>{t("nodeTab", { n: i + 1 })}{tab.closed ? ` · ${t("nodeTabClosed")}` : tab.busy ? ` · ${t("nodeTabBusy")}` : ""}</button><button aria-label={t("nodeCloseTab")} onClick={() => { if (!tab.closed) request("terminal_close", selected, {}, tab.id, tab.conversationId); terminalHistory.current.delete(`${selected}:${tab.id}`); setTabs((all) => ({ ...all, [selected]: (all[selected] ?? []).filter((x) => x.id !== tab.id) })); }}>×</button></div>)}<button aria-label={t("nodeNewTerminal")} disabled={connections[selected] !== "connected"} onClick={() => request("terminal_open", selected, {}, randomUuid())}>＋</button></div>
			<div className="node-terminals">{currentTabs.map((tab) => <RemoteTerminal key={`${selected}:${tab.id}`} nodeId={selected} tab={tab} active={active && activeTab?.id === tab.id} send={send} initialOutput={terminalHistory.current.get(`${selected}:${tab.id}`) ?? tab.output}  />)}{!currentTabs.length && <div className="node-empty">{t("nodeOpenHint")}</div>}</div>
			<div className="node-terminal-footer"><span>{t("nodeTerminalHint")}</span><button aria-expanded={showFiles} onClick={() => setShowFiles(!showFiles)}>{t("nodeShowFiles")}</button></div>
			{showFiles && <><div className="node-filebar"><input value={path} onChange={(e) => setPath(e.target.value)} aria-label={t("nodeDefaultDir")} /><button disabled={connections[selected] !== "connected"} onClick={() => listFiles(path)}>{t("nodeBrowse")}</button></div><div className="node-files">{entries.map((entry) => { const target = `${path.replace(/\/$/, "")}/${entry.name}`; return <button key={entry.name} onClick={() => entry.type === "dir" ? (setPath(target), listFiles(target)) : openFile(target)}>{entry.type === "dir" ? "▸" : "·"} {entry.name}</button>; })}</div></>}
			{file?.nodeId === selected && <div className="node-file-editor"><span>{file.path}</span><button onClick={saveFile}>{t("save")}</button><button onClick={() => setFile(null)}>{t("close")}</button><textarea aria-label={file.path} spellCheck={false} value={file.text} onChange={(e) => setFile({ ...file, text: e.target.value })} /></div>}
			</div>
			<div className="node-agent-container"><NodeAgentPanel key={selected} nodeId={selected} defaultDir={node.defaultDir} connected={connections[selected] === "connected"} agent={agents[selected]} request={request} draft={agentDrafts[selected] ?? ""} setDraft={value => setAgentDrafts(all => ({ ...all, [selected]: typeof value === "function" ? value(all[selected] ?? "") : value }))} consumedEditors={consumedAgentEditors.current} onViewTerminal={(terminalId, commandId) => {
				setActiveTabs(all => ({ ...all, [selected]: terminalId }));
				requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pi-node-terminal-jump", { detail: { nodeId: selected, terminalId, commandId } })));
			}} /></div>
			</div>
		</section></div>
		</div>}
		{sourceDraft && <div className="node-modal-backdrop"><form className="node-modal node-import-modal" ref={sourceDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("nodeAddSource")} onSubmit={e => { e.preventDefault(); if (!preview || !chosenKeys.length || sourceBusy) return; setSourceBusy(true); sourceRequest.current = request("source_add", undefined, { ...sourceDraft, enabled: sourceSync, selectedKeys: chosenKeys }); if (!sourceRequest.current) { setSourceBusy(false); setPreviewError(t("nodeOffline")); } }}>
			<header className="node-modal-heading"><h2>{t(sourceDraft.kind === "xshell" ? "nodeXshellEntry" : "nodeSshConfig")}</h2><button type="button" disabled={sourceBusy} aria-label={t("close")} onClick={() => setSourceDraft(null)}><FiX /></button></header>
			<p className="node-muted">{t("nodePreviewIntro")}</p>
			<div className="node-source-path"><label>{t("nodeSourcePath")}<input required autoFocus disabled={sourceBusy} value={sourceDraft.path} onChange={e => { setPreview(null); setChosenKeys([]); previewRequest.current = null; setSourceDraft({ ...sourceDraft, path: e.target.value }); }} /></label>{sourceDraft.kind === "xshell" && <button type="button" disabled={sourceBusy} onClick={() => setBrowseSource(true)}>{t("nodeBrowse")}</button>}</div>
			{previewError && <p className="node-error" role="alert">{previewError}</p>}
			{!preview && !previewError && <p className="node-muted" role="status">{t(sourceDraft.path.trim() ? "nodePreviewLoading" : "nodeSourcePathHint")}</p>}
			{preview && <><div className="node-preview-heading"><span>{t("nodePreviewCount", { n: preview.length, selected: chosenKeys.length })}</span><button type="button" disabled={sourceBusy} onClick={() => setChosenKeys(chosenKeys.length === preview.filter(n => !n.unsupported?.some(reason => reason !== "key")).length ? [] : preview.filter(n => !n.unsupported?.some(reason => reason !== "key")).map(n => n.sourceKey))}>{t(chosenKeys.length === preview.filter(n => !n.unsupported?.some(reason => reason !== "key")).length ? "nodeSelectNone" : "nodeSelectAll")}</button></div><div className="node-preview-list">{preview.map(n => { const blocked = !!n.unsupported?.some(reason => reason !== "key"); return <label key={n.sourceKey}><input type="checkbox" disabled={blocked || sourceBusy} checked={chosenKeys.includes(n.sourceKey)} onChange={e => setChosenKeys(keys => e.target.checked ? [...keys, n.sourceKey] : keys.filter(key => key !== n.sourceKey))} /><span><strong>{n.name}</strong><small>{n.username}@{n.host}:{n.port}</small></span><em className={blocked ? "unsupported" : "supported"} title={n.unsupported?.join(", ")}>{t(blocked ? "nodeImportSkipped" : "nodeImportReady")}</em></label>; })}</div></>}
			<p className="node-muted">{t("nodeSyncPassword")}</p><label className="node-checkbox"><input type="checkbox" disabled={sourceBusy} checked={sourceSync} onChange={e => setSourceSync(e.target.checked)} />{t("nodeAutoSync")}</label>
			<div className="node-modal-actions"><button type="button" disabled={sourceBusy} onClick={() => setSourceDraft(null)}>{t("cancel")}</button><button type="submit" disabled={sourceBusy || !preview || !chosenKeys.length} className="node-primary">{t(sourceBusy ? "nodeImporting" : "nodeImportSelected", { n: chosenKeys.length })}</button></div>
		</form></div>}
		{browseSource && <FolderPickerModal dirBrowse={dirBrowse} initialPath={sourceDraft?.path || undefined} onBrowse={path => { send({ type: "browse_dirs", path }); }} onPick={path => { setSourceDraft(current => current ? { ...current, path } : null); setBrowseSource(false); }} onClose={() => setBrowseSource(false)} />}

		{credentialNode && <div className="node-modal-backdrop"><form className="node-modal node-credential-modal" ref={credentialDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("nodeAuth")} onSubmit={(e) => { e.preventDefault(); const payload = { auth: credentialAuth, secret, persist: persistSecret, sameGroup, ...(credentialAuth === "key" ? { keyPath: credentialKeyPath } : {}) }; credentialAttempt.current = { nodeId: credentialNode.id, payload }; setTesting(true); request("credential_test", credentialNode.id, payload); }}><header className="node-modal-heading"><h2>{credentialNode.name}</h2><button type="button" disabled={testing} aria-label={t("close")} onClick={() => { opening.current.delete(credentialNode.id); setCredential(null); setSecret(""); credentialAttempt.current = null; }}><FiX /></button></header><code>{credentialNode.username}@{credentialNode.host}:{credentialNode.port}</code><label>{t("nodeAuth")}<select disabled={testing} value={credentialAuth} onChange={(e) => { setCredentialAuth(e.target.value as "password" | "key"); setSecret(""); setSameGroup(false); }}><option value="password">{t("nodePassword")}</option><option value="key">{t("nodeKey")}</option></select></label><p className="node-muted">{t("nodeLocalAuthHint")}</p><>{credentialAuth === "key" && <><label>{t("nodeKeyPath")}<input disabled={testing} required value={credentialKeyPath} onChange={(e) => setCredentialKeyPath(e.target.value)} /></label><p className="node-muted">{t("nodePrivateKeyHint")}</p></>}</><label>{t(credentialAuth === "key" ? "nodePassphrase" : "nodePassword")}<input disabled={testing} autoFocus type="password" autoComplete="new-password" required={credentialAuth === "password"} value={secret} onChange={(e) => setSecret(e.target.value)} /></label><label className="node-checkbox"><input type="checkbox" disabled={testing} checked={persistSecret} onChange={(e) => setPersistSecret(e.target.checked)} />{t("nodePersistSecret")}</label>{credentialAuth === "password" && <label className="node-checkbox"><input type="checkbox" disabled={testing} checked={sameGroup} onChange={(e) => setSameGroup(e.target.checked)} />{t("nodeGroupSecret")}</label>}{sameGroup && <p className="node-muted">{t("nodeGroupHint")}</p>}<p className="node-muted">{t("nodeCredentialHint")}</p><div className="node-modal-actions"><button type="button" disabled={testing} onClick={() => { opening.current.delete(credentialNode.id); setCredential(null); setSecret(""); credentialAttempt.current = null; }}>{t("cancel")}</button><button disabled={testing} className="node-primary">{t(testing ? "nodeTesting" : "nodeTestSave")}</button></div></form></div>}

		{draft && <div className="node-modal-backdrop"><form className="node-modal node-ssh-modal" ref={nodeDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("nodeAdd")} onSubmit={e => { e.preventDefault(); if (saveBusy) return; setError(""); setSaveBusy(true); const id = request("save", draft.id, { ...draft, secret: secret || undefined }); saveRequest.current = draft.id ? null : id; if (!id) { setSaveBusy(false); setError(t("nodeOffline")); } }}>
			<header className="node-modal-heading"><h2>{t(draft.id ? "nodeEdit" : "nodeSshEntry")}</h2><button type="button" disabled={saveBusy} aria-label={t("close")} onClick={() => setDraft(null)}><FiX /></button></header>
			<p className="node-muted">{t("nodeSshFormIntro")}</p>
			<label>{t("nodeName")}<input required disabled={saveBusy} value={draft.name ?? ""} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
			<div className="node-host-row"><label>{t("nodeAddress")}<input required disabled={saveBusy} value={draft.host ?? ""} onChange={e => setDraft({ ...draft, host: e.target.value })} /></label><label>{t("nodePort")}<input type="number" required min={1} max={65535} disabled={saveBusy} value={draft.port ?? 22} onChange={e => setDraft({ ...draft, port: Number(e.target.value) })} /></label></div>
			<label>{t("nodeUsername")}<input required autoComplete="username" disabled={saveBusy} value={draft.username ?? ""} onChange={e => setDraft({ ...draft, username: e.target.value })} /></label>
			{draft.auth !== "agent" && <label>{t(draft.auth === "key" ? "nodePassphrase" : "nodePassword")}<div className="node-password-field"><input type={showSecret ? "text" : "password"} autoComplete="new-password" disabled={saveBusy} required={draft.auth === "password" && !draft.hasSecret} value={secret} onChange={e => setSecret(e.target.value)} placeholder={draft.hasSecret ? t("nodeKeepSecret") : ""} /><button type="button" aria-label={t(showSecret ? "nodeHidePassword" : "nodeShowPassword")} aria-pressed={showSecret} onClick={() => setShowSecret(!showSecret)}>{showSecret ? <FiEyeOff /> : <FiEye />}</button></div></label>}
			<p className="node-muted">{t("nodeSecretLocal")}</p>
			<details className="node-advanced" open={draft.auth !== "password" || undefined}><summary>{t("nodeAdvancedOptions")}</summary>
			<label>{t("nodeAuth")}<select disabled={saveBusy} value={draft.auth} onChange={e => { setDraft({ ...draft, auth: e.target.value as Node["auth"] }); setSecret(""); }}><option value="password">{t("nodePassword")}</option><option value="key">{t("nodeKey")}</option><option value="agent">{t("nodeAgentAuth")}</option></select></label>
			{draft.auth === "key" && <label>{t("nodeKeyPath")}<input required disabled={saveBusy} value={draft.keyPath ?? ""} onChange={e => setDraft({ ...draft, keyPath: e.target.value })} /></label>}
			<label>{t("nodeGroup")}<input disabled={saveBusy} value={draft.group ?? ""} onChange={e => setDraft({ ...draft, group: e.target.value })} /></label><label>{t("nodeDefaultDir")}<input required disabled={saveBusy} value={draft.defaultDir ?? "/"} onChange={e => setDraft({ ...draft, defaultDir: e.target.value })} /></label>
			{!draft.id && <button type="button" className="node-text-action" onClick={() => { setDraft(null); setSourceDraft({ kind: "ssh", path: detected.find(s => s.kind === "ssh")?.path ?? "" }); }}>{t("nodeSshConfig")}</button>}
			{draft.id && draft.fingerprint && <button type="button" onClick={() => { if (window.confirm(t("nodeForgetHostKeyConfirm", { name: draft.name ?? "" }))) request("forget_host_key", draft.id); }}>{t("nodeForgetHostKey")}</button>}
			{draft.id && <button type="button" onClick={() => { if (window.confirm(t("nodeDeleteConfirm", { name: draft.name ?? "" }))) { request("delete", draft.id); setDraft(null); } }}>{t("nodeDelete")}</button>}
			</details>{error && <p className="node-error" role="alert">{error}</p>}
			<div className="node-modal-actions"><button type="button" disabled={saveBusy} onClick={() => setDraft(null)}>{t("cancel")}</button><button type="submit" className="node-primary" disabled={saveBusy}>{t(saveBusy ? "nodeSaving" : draft.id ? "save" : "nodeConnectSave")}</button></div>
		</form></div>}
	</div>;
}
