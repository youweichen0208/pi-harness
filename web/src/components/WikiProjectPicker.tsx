import { useEffect, useRef, useState } from "react";
import { FiBookOpen, FiFolder, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { wikiRequest } from "../wiki-api";
import type { ProjectWorkspaceCatalog, WikiProjectReference } from "../types";

export function WikiProjectPicker({ cwd, conversationId, onSelect, onClose }: {
	cwd: string; conversationId: string; onSelect: (project: WikiProjectReference | null) => void; onClose: () => void;
}) {
	const t = useT(), dialog = useRef<HTMLDialogElement>(null);
	const [catalog, setCatalog] = useState<ProjectWorkspaceCatalog | null>(null);
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let alive = true;
		const previous = dialog.current?.ownerDocument.activeElement as HTMLElement | null;
		dialog.current?.showModal();
		void wikiRequest<ProjectWorkspaceCatalog>(cwd, "chat-projects").then(result => { if (alive) setCatalog(result); }).catch(error => { if (alive) setError(error.message); });
		return () => { alive = false; dialog.current?.close(); previous?.focus(); };
	}, [cwd]);
	const choose = async (workspaceId: string, path: string) => {
		setBusy(true); setError("");
		try { onSelect(await wikiRequest<WikiProjectReference>(cwd, "chat-validate-project", { conversationId, workspaceId, path })); onClose(); }
		catch (error) { setError((error as Error).message); }
		finally { setBusy(false); }
	};
	const groups = catalog?.workspaces.map(group => ({ ...group, paths: group.paths.filter(path => `${group.name} ${path}`.toLowerCase().includes(query.toLowerCase())) })).filter(group => group.paths.length);
	return <dialog ref={dialog} className="wiki-assistant-sheet" onCancel={onClose} aria-label={t("wikiChooseProject")}>
		<header><h2>{t("wikiChooseProject")}</h2><button aria-label={t("close")} onClick={onClose}><FiX /></button></header>
		<input autoFocus className="wiki-assistant-search" aria-label={t("wikiSearch")} placeholder={t("wikiSearch")} value={query} onChange={event => setQuery(event.target.value)} />
		<div className="wiki-project-list">
			<button className="wiki-sheet-row" disabled={busy} onClick={() => { onSelect(null); onClose(); }}><FiBookOpen /><span>{t("wikiDocumentOnly")}</span></button>
			{groups?.map(group => <section key={group.id}><h3>{group.name}</h3>{group.paths.map(path => <button className="wiki-sheet-row" key={path} disabled={busy} onClick={() => void choose(group.id, path)}><FiFolder /><span><strong>{path.split(/[\\/]/).filter(Boolean).at(-1) || path}</strong><small>{path}</small></span></button>)}</section>)}
			{!catalog && !error && <p>{t("loading")}</p>}
			{groups?.length === 0 && <p>{t("wikiNoProjects")}</p>}
		</div>
		{error && <p className="wiki-assistant-error" role="alert">{error}</p>}
	</dialog>;
}
