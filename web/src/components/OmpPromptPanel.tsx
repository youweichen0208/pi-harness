import { useEffect, useRef, useState } from "react";
import { copyText } from "../clipboard";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { useT } from "../i18n";
import type { UiOmpPromptDocument, UiOmpPromptFile, UiOmpPromptState } from "../types";

export function OmpPromptPanel({ cwd, conversationId, running }: { cwd: string; conversationId: string; running: boolean }) {
	const t = useT();
	const [state, setState] = useState<UiOmpPromptState>();
	const [edit, setEdit] = useState<UiOmpPromptDocument>();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	const [copied, setCopied] = useState(false);
	const alive = useRef(false), working = useRef(false), controllers = useRef(new Set<AbortController>());
	const dirty = !!edit && edit.content !== text;
	async function request<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
		const controller = new AbortController(); controllers.current.add(controller);
		try {
			const response = await fetch(withToken("/api/system-prompt"), { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ clientId: getClientId(), cwd, conversationId, action, ...args }) });
			const data = await response.json(); if (!response.ok) throw Error(data.error ?? response.statusText); return data;
		} finally { controllers.current.delete(controller); }
	}
	async function perform(action: () => Promise<void>) {
		if (working.current) return;
		working.current = true; setBusy(true); setError("");
		try { await action(); } catch (error) { if (alive.current) setError((error as Error).message); }
		finally { working.current = false; if (alive.current) setBusy(false); }
	}
	const discard = () => !dirty || window.confirm(t("promptDiscard"));
	async function refresh(action: "get" | "reload") {
		const next = await request<UiOmpPromptState>(action);
		if (alive.current) { setState(next); setCopied(false); }
	}
	useEffect(() => {
		let active = true;
		alive.current = true; working.current = true; setBusy(true);
		void request<UiOmpPromptState>("get").then(next => { if (active) setState(next); }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) { working.current = false; setBusy(false); } });
		return () => { active = false; alive.current = false; for (const controller of controllers.current) controller.abort(); };
	}, []);
	useEffect(() => {
		if (!dirty) return;
		const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);
	function open(file: UiOmpPromptFile) {
		if (!discard()) return;
		void perform(async () => {
			const document = await request<UiOmpPromptDocument>("read", { fileId: file.id });
			if (alive.current) { setEdit(document); setText(document.content); }
		});
	}
	function save() {
		if (!edit) return;
		void perform(async () => {
			const next = await request<UiOmpPromptState>("save", { fileId: edit.file.id, version: edit.file.version, content: text });
			if (alive.current) { setState(next); setEdit(undefined); }
		});
	}
	function remove(file: UiOmpPromptFile) {
		if (!discard() || !window.confirm(t("ompPromptDeleteConfirm", { path: file.path }))) return;
		void perform(async () => {
			const next = await request<UiOmpPromptState>("delete", { fileId: file.id, version: file.version });
			if (alive.current) { setState(next); setEdit(undefined); }
		});
	}
	const unavailable = busy || !state?.available;
	return <section className="system-prompt-panel omp-prompt-panel" data-dirty={dirty} aria-label={t("settingsSystemPrompt")}>
		<header className="prompt-heading"><h2>{t("settingsSystemPrompt")}</h2><div className="prompt-heading-actions">
			<button disabled={busy} onClick={() => void perform(() => refresh("get"))}>{t("ompPromptRefresh")}</button>
			<button disabled={busy || running || dirty} onClick={() => void perform(() => refresh("reload"))}>{t("ompPromptReload")}</button>
		</div></header>
		<p className="settings-intro">{t("ompPromptIntro")}</p>
		{error && <p role="alert" className="prompt-error">{error}</p>}
		{state?.reloadError && <p role="alert" className="prompt-error">{state.reloadError}</p>}
		{state?.reloadRequired && <p role="status" className="prompt-save-status">{t("ompPromptPending")}</p>}
		{state && !state.available && <p role="status">{t("ompPromptStopped")}</p>}
		{!state && !error && <p>{t("loading")}</p>}
		{state?.available && <>
			<details className="omp-prompt-raw"><summary>{t("promptViewRaw")}</summary><button onClick={event => { const doc = event.currentTarget.ownerDocument; void copyText(state.blocks.join("\n\n"), doc).then(() => { if (alive.current) setCopied(true); }).catch(() => { if (alive.current) setError(t("promptCopyFailed")); }); }}>{t(copied ? "promptCopied" : "promptCopy")}</button>{state.blocks.map((block, index) => <pre className="prompt-raw" key={index}>{block}</pre>)}</details>
			<div className="settings-group omp-prompt-files">{state.files.map(file => <div className="omp-prompt-file" key={file.id}>
				<div><code>{file.path}</code><small>{t(file.kind === "template" ? "ompPromptTemplate" : file.kind === "system" ? "ompPromptLiteral" : "promptContext")}{file.selectedOnDisk && ` · ${t("ompPromptSelected")}`}{!file.exists && ` · ${t("ompPromptNotCreated")}`}</small>{file.error && <small className="prompt-error">{file.error}</small>}</div>
				<div className="prompt-row-actions"><button disabled={unavailable || !file.editable} onClick={() => open(file)}>{t(file.exists ? "promptEdit" : "ompPromptCreate")}</button>{file.exists && file.kind !== "context" && <button disabled={unavailable || running || !file.editable} onClick={() => remove(file)}>{t("delete")}</button>}</div>
			</div>)}</div>
		</>}
		{edit && <div className="prompt-editor" data-dirty={dirty}>
			<code className="prompt-editor-path">{edit.file.path}</code>
			<p className="prompt-warning">{t(edit.file.kind === "context" ? "promptContextHint" : "ompPromptWarning")}</p>
			<textarea aria-label={t("promptEditor")} autoFocus value={text} disabled={busy} onChange={event => setText(event.target.value)} spellCheck={false} />
			<div className="prompt-editor-actions"><button disabled={unavailable} onClick={() => open(edit.file)}>{t("promptReloadFile")}</button><button disabled={busy} onClick={() => { if (discard()) setEdit(undefined); }}>{t("cancel")}</button><button className="prompt-primary" disabled={unavailable || running || !dirty} onClick={save}>{t(busy ? "promptSaving" : "promptSave")}</button></div>
		</div>}
		{!!state?.sources.length && <details><summary>{t("ompPromptLoadedSources")}</summary>{state.sources.map((source, index) => <details key={index}><summary>{source.label}</summary><pre className="prompt-raw">{source.text}</pre></details>)}</details>}
	</section>;
}
