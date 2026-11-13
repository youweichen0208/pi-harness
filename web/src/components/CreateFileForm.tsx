import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FiFile, FiFolder } from "react-icons/fi";
import { useT } from "../i18n";
import { wikiRequest } from "../wiki-api";
import type { WorkspaceFileCreated } from "../types";

/** Shared manual file creation for the workspace tree and Wiki. */
export function CreateFileForm({ cwd, conversationId, initialPath = "", parentPath, kind = "file", inline = false, disabled, onCreated, onCancel }: {
	cwd: string; conversationId: string; initialPath?: string; parentPath?: string; kind?: "file" | "directory"; inline?: boolean; disabled?: boolean;
	onCreated: (path: string) => void; onCancel: () => void;
}) {
	const t = useT();
	const [path, setPath] = useState(initialPath), [error, setError] = useState(""), [busy, setBusy] = useState(false);
	const errorId = useId();
	const nameOnly = parentPath !== undefined;
	const invalidName = nameOnly && /[/\\]/.test(path);
	const canCreate = nameOnly ? !!path.trim() && !invalidName : !!path.split("/").at(-1)?.trim();
	const request = useRef<AbortController | null>(null);
	useEffect(() => () => { request.current?.abort(); }, []);
	const label = t(kind === "directory" ? "newWorkspaceFolder" : "newWorkspaceFile");
	const fieldLabel = t(kind === "directory" ? nameOnly ? "workspaceFolderName" : "workspaceFolderPath" : nameOnly ? "workspaceFileName" : "workspaceFilePath");
	const placeholder = t(kind === "directory" ? nameOnly ? "workspaceFolderNamePlaceholder" : "workspaceFolderPlaceholder" : nameOnly ? "workspaceFileNamePlaceholder" : "workspaceFilePlaceholder");
	const field = <input autoFocus value={path} aria-label={fieldLabel} aria-invalid={invalidName || !!error} aria-describedby={invalidName || error ? errorId : undefined} placeholder={placeholder} disabled={busy} onChange={event => { setPath(event.target.value); setError(""); }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); if (event.key === "Escape") { event.stopPropagation(); if (!busy) onCancel(); } }} />;
	const errorMessage = (invalidName || error) && <p id={errorId} role="alert">{invalidName ? t("workspaceNameNoSlash") : error}</p>;
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (busy || disabled || !canCreate) return;
		const controller = new AbortController(); request.current = controller;
		setBusy(true); setError("");
		try {
			const target = nameOnly ? [parentPath, path.trim()].filter(Boolean).join("/") : path;
			const result = await wikiRequest<WorkspaceFileCreated>(cwd, kind === "directory" ? "create-directory" : "create-file", { path: target, conversationId }, controller.signal);
			if (!controller.signal.aborted) onCreated(result.path);
		} catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
		finally { if (!controller.signal.aborted) setBusy(false); }
	};
	if (inline) return <form className="wiki-tree-create-form" aria-label={label} aria-busy={busy} onSubmit={submit}>
		<span className="tree-caret" aria-hidden="true" />
		{kind === "directory" ? <FiFolder className="tree-entry-icon tree-icon-folder" aria-hidden="true" /> : <FiFile className="tree-entry-icon tree-icon-document" aria-hidden="true" />}
		{field}
		{errorMessage && <div className="wiki-tree-create-error">{errorMessage}</div>}
	</form>;
	return <form className="create-file-form" aria-label={label} onSubmit={submit}>
		<label>{fieldLabel}{field}</label>
		{errorMessage}
		<div><button type="button" disabled={busy} onClick={onCancel}>{t("cancel")}</button><button type="submit" disabled={busy || disabled || !canCreate}>{t(busy ? "saving" : kind === "directory" ? "createWorkspaceFolder" : "createWorkspaceFile")}</button></div>
	</form>;
}
