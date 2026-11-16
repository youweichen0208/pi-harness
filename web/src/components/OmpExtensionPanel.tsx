import { OmpPathButton } from "./OmpPathButton";
import { useEffect, useRef, useState } from "react";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { useT } from "../i18n";
import type { OmpExtensionSettingKey, UiOmpExtensionState, UiOmpExtensionDocument } from "../types";

type Draft = Record<OmpExtensionSettingKey, { inherit: boolean; text: string }>;
const draftFrom = (state: UiOmpExtensionState): Draft => Object.fromEntries(state.settings.map(entry => [entry.key, { inherit: entry.global === null, text: (entry.global ?? entry.value).join("\n") }])) as Draft;
export function OmpExtensionPanel({ cwd, conversationId, running }: { cwd: string; conversationId: string; running: boolean }) {
	const t = useT();
	const [edit, setEdit] = useState<UiOmpExtensionDocument>();
	const [text, setText] = useState("");
	const editTrigger = useRef<HTMLButtonElement | null>(null);
	const [state, setState] = useState<UiOmpExtensionState>();
	const [draft, setDraft] = useState<Draft>();
	const [baseline, setBaseline] = useState("");
	const [version, setVersion] = useState("");
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	const alive = useRef(false), writing = useRef(false), sequence = useRef(0), controllers = useRef(new Set<AbortController>());
	const sourceDirty = !!edit && edit.content !== text;
	const settingsDirty = !!draft && JSON.stringify(draft) !== baseline;
	const dirty = sourceDirty || settingsDirty;
	const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
	function accept(next: UiOmpExtensionState, reset = false) {
		setState(next);
		if (next.available && (reset || !dirtyRef.current)) { const fresh = draftFrom(next); setDraft(fresh); setBaseline(JSON.stringify(fresh)); setVersion(next.version); }
	}
	async function request<T = UiOmpExtensionState>(action: string, payload: Record<string, unknown> = {}) {
		const controller = new AbortController(); controllers.current.add(controller);
		try {
			const response = await fetch(withToken("/api/omp-extensions"), { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: getClientId(), cwd, conversationId, action, ...payload }) });
			const next = await response.json(); if (!response.ok) throw Error(next.error ?? response.statusText); return next as T;
		} finally { controllers.current.delete(controller); }
	}
	useEffect(() => {
		let active = true, timer: ReturnType<typeof setTimeout>;
		alive.current = true;
		const poll = async () => {
			if (!writing.current) {
				const id = ++sequence.current;
				try { const next = await request("get"); if (active && id === sequence.current) accept(next); }
				catch (error) { if (active && id === sequence.current) setError((error as Error).message); }
			}
			if (active) timer = setTimeout(() => void poll(), 3000);
		};
		void poll();
		return () => { active = false; alive.current = false; clearTimeout(timer); for (const controller of controllers.current) controller.abort(); };
	}, []);
	useEffect(() => {
		if (!dirty) return;
		const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);
	async function mutate(action: string, payload: Record<string, unknown> = {}) {
		if (writing.current) return;
		writing.current = true; ++sequence.current; setBusy(true); setError("");
		try { const next = await request(action, payload); if (alive.current) { accept(next, true); if (action === "get" || action === "restart") setEdit(undefined); } }
		catch (error) { if (alive.current) setError((error as Error).message); }
		finally { writing.current = false; if (alive.current) setBusy(false); }
	}
	async function editFile(moduleId: string, trigger?: HTMLButtonElement) {
		if (writing.current || sourceDirty && !window.confirm(t("extDiscard"))) return;
		if (trigger) editTrigger.current = trigger;
		writing.current = true; ++sequence.current; setBusy(true); setError("");
		try {
			const file = await request<UiOmpExtensionDocument>("read-file", { moduleId });
			if (alive.current) { setEdit(file); setText(file.content); }
		} catch (error) { if (alive.current) setError((error as Error).message); }
		finally { writing.current = false; if (alive.current) setBusy(false); }
	}
	async function saveFile() {
		if (!edit || writing.current) return;
		writing.current = true; ++sequence.current; setBusy(true); setError("");
		try {
			const file = await request<UiOmpExtensionDocument>("save-file", { moduleId: edit.moduleId, version: edit.version, content: text });
			if (alive.current) { setEdit(file); setText(file.content); setState(previous => previous && { ...previous, restartRequired: true }); }
		} catch (error) { if (alive.current) setError((error as Error).message); }
		finally { writing.current = false; if (alive.current) setBusy(false); }
	}

	const toggleBlocked = state?.settings.some(entry => entry.key === "disabledExtensions" && !["global", "default"].includes(entry.source));
	const save = () => { if (draft) void mutate("save", { version, patch: Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.inherit ? null : value.text.split("\n").map(item => item.trim()).filter(Boolean)])) }); };
	return <section className="omp-extension-panel" data-dirty={dirty} aria-label={t("ompExtTitle")}>
		<div className="omp-mcp-actions"><button disabled={busy || dirty || running} onClick={() => void mutate("restart")}>{t("ompExtRestart")}</button><button disabled={busy} onClick={() => { if (!dirty || window.confirm(t("extDiscard"))) void mutate("get"); }}>{t("ompPromptRefresh")}</button></div>
		<p className="settings-intro">{t("ompExtIntro")}</p>
		{error && <p role="alert" className="settings-error">{error}</p>}
		{state?.restartRequired && <p role="status">{t("ompExtRestartNeeded")}</p>}
		{toggleBlocked && <p className="settings-intro">{t("ompExtHigherPriority")}</p>}
		{state && !state.available && <p role="status">{t("ompExtStopped")}</p>}
		{!state && !error && <p>{t("loading")}</p>}
		<div className="settings-group">{state?.modules.map(module => <div className="settings-skill-row" key={module.id}>
			<div className="settings-skill-info"><code>{module.name}</code><small>{module.path}</small><small>{t(module.active ? module.enabled ? "ompExtActive" : "ompExtSuspending" : !module.enabled ? "ompExtDisabled" : module.loaded ? "ompExtResuming" : "ompExtUnloaded")}</small>{!module.toggleKey && <small>{t("ompExtExplicit")}</small>}</div>
			<OmpPathButton cwd={cwd} conversationId={conversationId} target={{ kind: "module", id: module.id }} />
			{module.editable && <button disabled={busy || !state?.available} onClick={event => void editFile(module.id, event.currentTarget)} aria-label={t("ompExtEditSource", { name: module.name })}>{t("extEditFile")}</button>}
			{module.toggleKey && <button role="switch" aria-checked={module.enabled} aria-label={t("ompExtSwitch", { name: module.name })} disabled={busy || running || dirty || toggleBlocked} onClick={() => void mutate("toggle", { version: state.version, moduleId: module.id, enabled: !module.enabled })}>{t(module.enabled ? "ompExtDisable" : "ompExtEnable")}</button>}
		</div>)}</div>
		{edit && <div className="prompt-editor omp-extension-editor" data-dirty={sourceDirty}>
			<code className="prompt-editor-path">{edit.path}</code>
			<p className="settings-intro">{t("ompExtSourceHint")}</p>
			<textarea aria-label={t("extEditFile")} autoFocus spellCheck={false} value={text} disabled={busy} onChange={event => setText(event.target.value)} />
			<div className="prompt-editor-actions">
				<button disabled={busy || !state?.available} onClick={() => void editFile(edit.moduleId)}>{t("promptReloadFile")}</button>
				<button disabled={busy} onClick={() => { if (!sourceDirty || window.confirm(t("extDiscard"))) { setEdit(undefined); editTrigger.current?.focus(); } }}>{t("cancel")}</button>
				<button disabled={busy || running || !state?.available || !sourceDirty} onClick={() => void saveFile()}>{t("extSaveFile")}</button>
			</div>
		</div>}

		{state?.available && draft && <details className="omp-extension-settings"><summary>{t("ompExtSettings")}</summary><p className="settings-intro">{t("ompExtSettingsHint")}</p>
			{state.settings.map(entry => <fieldset key={entry.key} disabled={busy || running}>
				<legend>{t(entry.key === "extensions" ? "ompExtPaths" : "ompExtDisabledIds")}</legend>
				<label><input type="checkbox" checked={draft[entry.key].inherit} onChange={event => setDraft({ ...draft, [entry.key]: { ...draft[entry.key], inherit: event.target.checked } })} />{t("ompExtDefault")}</label>
				<textarea aria-label={t(entry.key === "extensions" ? "ompExtPaths" : "ompExtDisabledIds")} value={draft[entry.key].text} disabled={draft[entry.key].inherit} onChange={event => setDraft({ ...draft, [entry.key]: { ...draft[entry.key], text: event.target.value } })} spellCheck={false} />
				<small>{t("ompExtEffective", { source: t(`ompSettingSource_${entry.source}`), value: JSON.stringify(entry.value) })}</small>
			</fieldset>)}
			<button disabled={busy || running || !settingsDirty} onClick={save}>{t("ompExtSave")}</button>
		</details>}
	</section>;
}
