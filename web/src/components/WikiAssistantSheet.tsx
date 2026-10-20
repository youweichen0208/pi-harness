import { useEffect, useMemo, useRef, useState } from "react";
import { FiChevronRight, FiFileText, FiFolder, FiX, FiEdit2, FiTrash2 } from "react-icons/fi";
import { useT } from "../i18n";
import { wikiRequest } from "../wiki-api";
import type { WikiChatSummary, WikiDirectory, WikiEntry, WikiState } from "../types";

export function WikiAssistantSheet({ kind, cwd, conversationId, documentPath, currentIncluded, references, onReferences, onChatAction, onClose }: {
	currentIncluded: boolean; kind: "documents" | "history"; cwd: string; conversationId: string; documentPath: string; references: string[];
	onReferences: (paths: string[]) => Promise<void>; onChatAction: (action: string, id?: string) => void; onClose: () => void;
}) {
	const t = useT();
	const dialog = useRef<HTMLDialogElement>(null);
	const [query, setQuery] = useState("");
	const [days, setDays] = useState(0);
	const [folder, setFolder] = useState<string | null>(null);
	const [entries, setEntries] = useState<WikiEntry[]>([]);
	const [directory, setDirectory] = useState<WikiDirectory | null>(null);
	const [history, setHistory] = useState<WikiChatSummary[]>([]);
	const [selected, setSelected] = useState(() => [...references]);
	const [limited, setLimited] = useState(false);
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [deleting, setDeleting] = useState<string | null>(null);
	useEffect(() => {
		const previous = (dialog.current?.ownerDocument ?? document).activeElement as HTMLElement | null;
		dialog.current?.showModal();
		return () => { dialog.current?.close(); previous?.focus({ preventScroll: true }); };
	}, []);
	useEffect(() => {
		let alive = true; setBusy(true); setError("");
		const load = async () => {
			if (kind === "history") {
				const items = await wikiRequest<WikiChatSummary[]>(cwd, "chat-list", { path: documentPath });
				if (alive) setHistory(items);
			} else if (folder !== null) {
				const value = await wikiRequest<WikiDirectory>(cwd, "directory", { path: folder });
				if (alive) setDirectory(value);
			} else {
				const value = await wikiRequest<WikiState>(cwd, "state");
				if (alive) { setEntries(value.entries); setLimited(value.limited); }
			}
		};
		void load().catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setBusy(false); });
		return () => { alive = false; };
	}, [cwd, kind, folder]);
	const files = useMemo(() => {
		const now = new Date(); now.setHours(0, 0, 0, 0);
		const cutoff = days === 1 ? now.getTime() : Date.now() - days * 86400000;
		return (folder === null ? entries : directory?.entries ?? []).filter(entry => {
			if (entry.kind === "directory") return folder !== null;
			return /\.(md|markdown|txt)$/i.test(entry.path) && (!days || entry.modified >= cutoff) && `${entry.title ?? ""} ${entry.path}`.toLowerCase().includes(query.toLowerCase());
		});
	}, [entries, directory, folder, query, days]);
	const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
	const toggle = (path: string) => setSelected(items => items.includes(path) ? items.filter(item => item !== path) : [...items, path]);
	return <dialog ref={dialog} className="wiki-assistant-sheet" onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="wiki-sheet-title">
		<header><h2 id="wiki-sheet-title">{t(kind === "documents" ? "wikiChooseDocuments" : "wikiChatHistory")}</h2><button onClick={onClose} aria-label={t("close")}><FiX /></button></header>
		<input autoFocus className="wiki-assistant-search" aria-label={t("wikiSearch")} placeholder={t("wikiSearch")} value={query} onChange={e => setQuery(e.target.value)} />
		{kind === "documents" && <>
			{documentPath && <p className="wiki-current-reference"><FiFileText />{t(currentIncluded ? "wikiFollowingDocument" : "wikiCurrentExcluded")} <strong title={documentPath}>{documentPath.split("/").at(-1)}</strong></p>}
			<div className="wiki-document-filters">{([0, 1, 7, 30] as const).map(value => <button key={value} aria-pressed={days === value} onClick={() => { setDays(value); setFolder(null); }}>{t(value === 0 ? "wikiAllDocuments" : value === 1 ? "wikiModifiedToday" : value === 7 ? "wikiModifiedWeek" : "wikiModifiedMonth")}</button>)}</div>
			<button className="wiki-folder-breadcrumb" onClick={() => { setDays(0); setFolder(folder ? folder.split("/").slice(0, -1).join("/") : ""); }}><FiFolder />{folder === null ? t("wikiBrowseFolders") : `${t("wikiParentFolder")} / ${folder}`}</button>
			{limited && <p className="wiki-assistant-hint">{t("wikiSelectionLimited")}</p>}
		</>}
		{error && <p role="alert" className="wiki-assistant-error">{error}</p>}
		<div className="wiki-sheet-list" aria-busy={busy}>
			{kind === "documents" ? files.map(entry => entry.kind === "directory" ? <button key={entry.path} className="wiki-sheet-row" onClick={() => setFolder(entry.path)}><FiFolder /><span>{entry.name}</span><FiChevronRight /></button> : <label key={entry.path} className="wiki-sheet-row"><input type="checkbox" checked={selected.includes(entry.path)} onChange={() => toggle(entry.path)} disabled={busy || (!selected.includes(entry.path) && selected.length >= 100)} /><FiFileText /><span><strong>{entry.title || entry.name}</strong><small>{entry.path}</small></span></label>) : history.filter(item => item.title.toLowerCase().includes(query.toLowerCase())).map(item => <div className="wiki-history-row" key={item.id}>
				{editing === item.id ? <form onSubmit={event => { event.preventDefault(); void run(async () => { await wikiRequest(cwd, "chat-rename", { conversationId, id: item.id, title }); setHistory(items => items.map(row => row.id === item.id ? { ...row, title } : row)); setEditing(null); }); }}><input aria-label={t("renameSession")} value={title} maxLength={120} onChange={e => setTitle(e.target.value)} autoFocus /><button disabled={busy || !title.trim()}>{t("save")}</button><button type="button" onClick={() => setEditing(null)}>{t("cancel")}</button></form> : <><button className="wiki-history-open" onClick={() => { onChatAction("chat-open", item.id); onClose(); }}><strong>{item.title}</strong><small>{new Date(item.updated).toLocaleString()}</small></button><button aria-label={t("renameSession")} onClick={() => { setEditing(item.id); setTitle(item.title); }}><FiEdit2 /></button><button aria-label={t("delete")} onClick={() => setDeleting(item.id)}><FiTrash2 /></button></>}
				{deleting === item.id && <div className="wiki-delete-confirm"><span>{t("wikiDeleteChatConfirm")}</span><button onClick={() => { onChatAction("chat-delete", item.id); onClose(); }}>{t("delete")}</button><button onClick={() => setDeleting(null)}>{t("cancel")}</button></div>}
			</div>)}
			{busy && <p className="wiki-assistant-hint">{t("loadingSession")}</p>}
			{!busy && !(kind === "documents" ? files.length : history.filter(item => item.title.toLowerCase().includes(query.toLowerCase())).length) && <p className="wiki-assistant-hint">{t("wikiNoItems")}</p>}
			{kind === "documents" && folder !== null && directory?.nextOffset !== undefined && <button disabled={busy} onClick={() => void run(async () => { const next = await wikiRequest<WikiDirectory>(cwd, "directory", { path: folder, offset: directory.nextOffset }); setDirectory({ ...next, entries: [...directory.entries, ...next.entries] }); })}>{t("wikiLoadMore")}</button>}
		</div>
		<footer>{kind === "documents" ? <><button disabled={busy} onClick={() => setSelected([])}>{t("wikiClearReferences")}</button><span>{selected.length} / 100</span><button onClick={onClose}>{t("cancel")}</button><button className="wiki-assistant-primary" disabled={busy} onClick={() => void run(async () => { await onReferences(selected); onClose(); })}>{t("confirm")}</button></> : <button onClick={onClose}>{t("close")}</button>}</footer>
	</dialog>;
}
