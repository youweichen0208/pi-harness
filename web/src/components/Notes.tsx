import { useEffect, useMemo, useRef, useState } from "react";
import { RichMarkdownEditor, type RichEditorHost } from "./RichMarkdownEditor";
import { RichDocumentPreview } from "./RichDocumentPreview";
import { withToken } from "../auth-token";
const notesHost: RichEditorHost = {
	async uploadImage(data, signal) {
		const response = await fetch(withToken("/api/notes/assets"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }), signal });
		if (!response.ok) throw Error("Image upload failed");
		return (await response.json()).path;
	},
	resolveImage: source => source.startsWith("/api/notes/assets/") ? withToken(source) : source,
};
import { useT } from "../i18n";
import type { NotesController } from "../use-notes";
import { usePlaygroundHost } from "../playground-context";
import { runKey, startRun } from "../playground-run-store";
import { PlaygroundResult } from "./PlaygroundRun";

export function NotesList({ notes: n }: { notes: NotesController }) {
	const t = useT();
	return <div className="notes-list">
		<div className="notes-list-heading"><strong>{t("notesTitle")}</strong><button className="workspace-add" aria-label={t("notesNew")} disabled={n.creating} onClick={() => void n.create()}>+</button></div>
		<input type="search" aria-label={t("notesSearch")} placeholder={t("notesSearch")} value={n.query} onChange={e => n.setQuery(e.target.value)} />
		{n.listError && <p role="alert">{t("notesFailed")} <button onClick={() => void n.refresh()}>{t("notesRetry")}</button></p>}
		{!n.notes.length && <p className="panel-empty">{t(n.query ? "notesNoMatches" : "notesEmpty")}</p>}
		{n.notes.map(note => <button key={note.id} className={`note-list-item ${n.selected === note.id ? "active" : ""}`} onClick={() => n.select(note.id)}><strong>{note.pinned ? "↑ " : ""}{note.title.trim() || t("notesUntitled")}</strong><small>{new Date(note.updatedAt).toLocaleString()}</small></button>)}
	</div>;
}
export function NotesEditor({ notes: n }: { notes: NotesController }) {
	const t = useT();
	const [source, setSource] = useState(false);
	const [preview, setPreview] = useState(false);
	const textarea = useRef<HTMLTextAreaElement>(null);
	// A Run started from a Note remembers the exact source it ran, so the result can
	// be labelled stale the moment that source is edited away. Hooks stay above the
	// `!d` early return.
	const { status } = usePlaygroundHost();
	const [lastRun, setLastRun] = useState<{ code: string; key: string } | null>(null);
	useEffect(() => { setLastRun(null); }, [n.selected]);
	const canRun = !!status?.enabled && status.python.available;
	// Only the Notes host offers a Run control; the Wiki host does not, so its code
	// blocks get no button at all.
	const host = useMemo<RichEditorHost>(() => canRun
		? { ...notesHost, runCode: code => { const key = runKey(`note:${n.selected}`, code); setLastRun({ code, key }); void startRun(key, code); } }
		: notesHost, [canRun, n.selected]);
	const d = n.draft;
	if (!d) return <section className="notes-editor notes-empty"><h2>{t("notesTitle")}</h2><p>{t("notesChoose")}</p><button disabled={n.creating} onClick={() => void n.create()}>{t("notesNew")}</button></section>;
	return <section className="notes-editor" aria-label={t("notesTitle")}>
		<div className="notes-toolbar">
			<button onClick={() => { setSource(value => !value); setPreview(false); }}>{t(source ? "notesRich" : "notesSource")}</button>
			<button onClick={() => setPreview(value => !value)}>{t(preview ? "notesEdit" : "notesPreview")}</button>
			<button onClick={() => {
				const at = textarea.current?.selectionStart ?? d.note.body.length;
				n.edit({ body: `${d.note.body.slice(0, at)}\n- [ ] ${d.note.body.slice(at)}` }); setPreview(false);
				requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(at + 7, at + 7); });
			}}>{t("notesTodo")}</button>
			<button aria-pressed={d.note.pinned} onClick={() => n.edit({ pinned: !d.note.pinned })}>{t(d.note.pinned ? "notesUnpin" : "notesPin")}</button>
			<button disabled={d.saving} onClick={() => { if (window.confirm(t("notesDeleteConfirm"))) void n.remove(); }}>{t("notesDelete")}</button>
			<span role="status">{t(d.saving ? "notesSaving" : d.error ? "notesFailed" : d.dirty ? "notesPending" : "notesSaved")}</span>
		</div>
		{d.error > 0 && <div className="notes-error" role="alert"><p>{t(d.error === 409 || d.error === 404 ? "notesConflict" : "notesFailed")}</p>
			{d.error !== 409 && d.error !== 404 && <button onClick={() => void n.save(n.selected)}>{t("notesRetry")}</button>}
			<button disabled={d.saving} onClick={() => { if (window.confirm(t("notesReloadConfirm"))) void n.reload(); }}>{t("notesReload")}</button>
			<button disabled={d.saving || n.creating} onClick={() => void n.create(true)}>{t("notesSaveCopy")}</button>
		</div>}
		<input className="note-title" aria-label={t("notesName")} placeholder={t("notesUntitled")} maxLength={500} value={d.note.title} onChange={e => n.edit({ title: e.target.value })} />
		{preview ? <RichDocumentPreview key={n.selected} value={d.note.body} onChange={body => n.edit({ body })} host={host} /> : !source ? <RichMarkdownEditor key={n.selected} value={d.note.body} onChange={body => n.edit({ body })} readOnly={false} host={host} compact /> : <textarea ref={textarea} aria-label={t("notesBody")} placeholder={t("notesBodyHint")} value={d.note.body} onChange={e => n.edit({ body: e.target.value })} />}
		{lastRun && !preview && <PlaygroundResult runKey={lastRun.key} stale={!d.note.body.includes(lastRun.code)} />}
	</section>;
}
