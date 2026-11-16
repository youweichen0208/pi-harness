import { useEffect, useRef, useState } from "react";
import type { OmpMcpScope, UiOmpMcpState, UiOmpMcpRuntime } from "../types";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { useT } from "../i18n";
import { OmpMcpDraftError, ompMcpForm, ompMcpServers, removeOmpMcpServer, saveOmpMcpForm } from "../omp-mcp-edit";
import type { OmpMcpForm } from "../omp-mcp-edit";
import { OmpMcpImportError, previewOmpMcpImport, type OmpMcpImportPreview } from "../omp-mcp-import";
import { OmpMcpDiagnostics, OmpMcpFailure } from "./OmpMcpDiagnostics";

export function OmpMcpPanel({ cwd, conversationId, busy }: { cwd: string; conversationId: string; busy: boolean }) {
	const t = useT();
	const [scope, setScope] = useState<OmpMcpScope>("global");
	const [config, setConfig] = useState<UiOmpMcpState["config"]>();
	const [runtime, setRuntime] = useState<UiOmpMcpRuntime>();
	const [draft, setDraft] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [authInput, setAuthInput] = useState("");
	const authBusy = runtime?.auth?.status === "pending";
	const [editorOpen, setEditorOpen] = useState(false);
	const [form, setForm] = useState<{ originalName?: string; initial: OmpMcpForm; fields: OmpMcpForm }>();
	const [importDraft, setImportDraft] = useState<{ text: string; preview?: OmpMcpImportPreview }>();
	const importFocus = useRef<HTMLTextAreaElement>(null), importTrigger = useRef<HTMLButtonElement>(null);
	const closeImport = () => { setImportDraft(undefined); requestAnimationFrame(() => importTrigger.current?.focus()); };
	const formFocus = useRef<HTMLInputElement>(null), formTrigger = useRef<HTMLButtonElement>();
	const lifecycle = useRef({ active: true, version: 0, writing: false, controllers: new Set<AbortController>() });
	const jsonDirty = !!config && draft !== JSON.stringify(config.document, null, 2);
	const dirty = !!importDraft?.text || jsonDirty || !!form && JSON.stringify(form.initial) !== JSON.stringify(form.fields);
	const writeDisabled = busy || loading || !!authBusy || runtime?.workerAvailable === false;
	let servers: Record<string, Record<string, unknown>> = {};
	try { if (config) servers = ompMcpServers(config.document); } catch { /* Keep raw JSON repair available. */ }
	const closeForm = () => { setForm(undefined); requestAnimationFrame(() => { if (formTrigger.current?.isConnected) formTrigger.current.focus(); }); };
	const draftError = (error: unknown) => setError(t(error instanceof OmpMcpDraftError ? error.key : "ompMcpFormInvalid"));
	const openForm = (button: HTMLButtonElement, name?: string) => {
		if (!config) return;
		try { const fields = ompMcpForm(config.document, name, scope); formTrigger.current = button; setForm({ originalName: name, initial: fields, fields }); setError(""); }
		catch (error) { draftError(error); }
	};
	const updateForm = (key: keyof OmpMcpForm, value: string) => setForm(current => current ? { ...current, fields: { ...current.fields, [key]: value } } : current);
	useEffect(() => { if (importDraft) importFocus.current?.focus(); }, [!!importDraft]);
	useEffect(() => { if (form) formFocus.current?.focus(); }, [!!form, form?.originalName]);
	useEffect(() => {
		if (!dirty) return;
		const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
	}, [dirty]);
	const call = async (action: string, extra: Record<string, unknown> = {}) => {
		const controller = new AbortController(), life = lifecycle.current;
		life.controllers.add(controller);
		try {
			const response = await fetch(withToken("/api/omp-mcp"), { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: getClientId(), cwd, conversationId, action, scope, ...extra }) });
			const data = await response.json(); if (!response.ok) throw Error(data.error ?? response.statusText);
			return data as UiOmpMcpState;
		} finally { life.controllers.delete(controller); }
	};
	const request = async (action: "get" | "save" | "reload" | "reconnect" | "login" | "logout" | "auth_cancel" | "auth_input", name?: string, prepared?: Record<string, unknown>) => {
		const life = lifecycle.current, version = ++life.version;
		life.writing = true; setLoading(true); setError("");
		try {
			let document: unknown;
			if (action === "save") { try { document = prepared ?? JSON.parse(draft); } catch { throw Error(t("ompMcpInvalidJson")); } }
			let data = await call(action, { version: config?.version, document, name, authId: runtime?.auth?.id, ...(action === "auth_input" ? { value: authInput } : {}) });
			if (action === "reload" && life.active && life.version === version) data = await call("get");
			if (!life.active || life.version !== version) return;
			setRuntime(data); if (action === "auth_input" || action === "login" || action === "auth_cancel") setAuthInput("");
			if (data.config) { setConfig(data.config); setDraft(JSON.stringify(data.config.document, null, 2)); if (form) closeForm(); if (importDraft) closeImport(); }
		} catch (error) { if (life.active && life.version === version) setError((error as Error).message); }
		finally { if (life.active && life.version === version) { life.writing = false; setLoading(false); } }
	};
	useEffect(() => {
		const life = { active: true, version: 0, writing: false, controllers: new Set<AbortController>() }; lifecycle.current = life;
		setAuthInput(""); setConfig(undefined); setRuntime(undefined); setDraft(""); setForm(undefined); setImportDraft(undefined); void request("get");
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			const version = life.version;
			if (!life.writing) {
				try { const data = await call("status"); if (life.active && life.version === version) setRuntime(data); }
				catch (error) { if (life.active && life.version === version) setError(previous => previous || (error as Error).message); }
			}
			if (life.active) timer = setTimeout(poll, 3000);
		};
		timer = setTimeout(poll, 3000);
		return () => { life.active = false; clearTimeout(timer); for (const controller of life.controllers) controller.abort(); };
	}, [cwd, conversationId, scope]);
	const discard = () => !dirty || window.confirm(t("mcpDiscard"));
	return <section className="omp-mcp-panel" data-dirty={dirty} aria-label={t("ompMcpTitle")}>
		<h3>{t("ompMcpTitle")}</h3><p className="settings-intro">{t("ompMcpIntro")}</p>
		<div className="omp-mcp-actions">
			<label>{t("mcpScope")} <select value={scope} disabled={loading} onChange={event => { if (discard()) setScope(event.target.value as OmpMcpScope); }}><option value="global">{t("mcpGlobal")}</option><option value="project">{t("mcpProject")}</option></select></label>
			<button className="btn sm" disabled={loading} onClick={() => { if (discard()) void request("get"); }}>{t("ompMcpRead")}</button>
			<button className="btn sm" disabled={busy || loading || dirty || !!form || !!importDraft || authBusy} onClick={() => void request("reload")}>{t("ompMcpReload")}</button>
		</div>
		{error && <p role="alert" className="settings-error">{error}</p>}
		{runtime?.workerAvailable === false && <p role="status">{t("ompExtStopped")}</p>}
		{runtime?.reloadRequired && <p role="status">{t("ompMcpPending")}</p>}
		{runtime?.projectConfigEnabled === false && <p className="settings-intro">{t("ompMcpProjectDisabled")}</p>}
		{config && <div className="omp-mcp-configured">
			<h4>{t("ompMcpConfigured")}</h4>
			<p className="settings-intro">{t("ompMcpFormHelp")}</p>
			<button className="btn sm" disabled={writeDisabled || jsonDirty || !!form || !!importDraft} onClick={event => openForm(event.currentTarget)}>{t("mcpNew")}</button>
			<button ref={importTrigger} className="btn sm" disabled={writeDisabled || jsonDirty || !!form || !!importDraft} onClick={() => { setError(""); setImportDraft({ text: "" }); }}>{t("ompMcpImport")}</button>
			{importDraft && <form className="omp-mcp-form" aria-label={t("ompMcpImport")} onSubmit={event => {
				event.preventDefault(); if (writeDisabled) return;
				try { const preview = previewOmpMcpImport(config.document, importDraft.text); setImportDraft({ ...importDraft, preview }); setError(""); }
				catch (error) { setImportDraft({ ...importDraft, preview: undefined }); setError(t(error instanceof OmpMcpImportError ? error.key : "ompMcpImportInvalid")); }
			}}>
				<fieldset disabled={writeDisabled}>
					<legend>{t("ompMcpImport")}</legend><p className="settings-intro">{t("ompMcpImportHelp")}</p>
					<label>{t("ompMcpImportJson")}<textarea ref={importFocus} aria-label={t("ompMcpImportJson")} value={importDraft.text} autoComplete="off" spellCheck={false} maxLength={1048576} onChange={event => setImportDraft({ text: event.target.value })} /></label>
					{importDraft.preview && <div role="status"><p>{t("ompMcpImportReady", { n: importDraft.preview.names.length })}</p><ul>{importDraft.preview.names.map(name => <li key={name}>{name}</li>)}</ul></div>}
					<div className="omp-mcp-actions">
						<button className="btn" type="submit" disabled={!importDraft.text.trim()}>{t("ompMcpImportPreview")}</button>
						<button className="btn primary" type="button" disabled={!importDraft.preview} onClick={() => { if (importDraft.preview) void request("save", undefined, importDraft.preview.document); }}>{t("ompMcpImportSave")}</button>
						<button className="btn" type="button" onClick={closeImport}>{t("cancel")}</button>
					</div>
				</fieldset>
			</form>}
			<div className="settings-group">{Object.entries(servers).map(([name, value]) => <div className="omp-mcp-config-row" key={name}>
				<strong>{name}</strong><span>{String(value.type ?? "stdio")}</span>
				<button className="btn sm" aria-label={t("ompMcpEditNamed", { name })} disabled={writeDisabled || jsonDirty || !!form || !!importDraft} onClick={event => openForm(event.currentTarget, name)}>{t("mcpEdit")}</button>
				<button className="btn sm" aria-label={t("ompMcpRemoveNamed", { name })} disabled={writeDisabled || jsonDirty || !!form || !!importDraft} onClick={() => { if (window.confirm(t("ompMcpRemoveConfirm", { name }))) { try { void request("save", undefined, removeOmpMcpServer(config.document, name)); } catch (error) { draftError(error); } } }}>{t("delete")}</button>
			</div>)}</div>
			{form && <form className="omp-mcp-form" aria-label={t("ompMcpServerForm")} onSubmit={event => { event.preventDefault(); if (writeDisabled) return; try { void request("save", undefined, saveOmpMcpForm(config.document, form.fields, form.originalName, scope)); } catch (error) { draftError(error); } }}>
				<fieldset disabled={writeDisabled}>
					<legend>{form.originalName === undefined ? t("mcpNew") : form.originalName}</legend>
					<label>{t("mcpName")}<input ref={formFocus} value={form.fields.name} readOnly={form.originalName !== undefined} maxLength={100} onChange={event => updateForm("name", event.target.value)} /></label>
					<label>{t("ompMcpTransport")}<select aria-label={t("ompMcpTransport")} value={form.fields.type} onChange={event => updateForm("type", event.target.value)}><option value="stdio">stdio</option><option value="http">HTTP</option><option value="sse">SSE</option>{!["stdio", "http", "sse"].includes(form.fields.type) && <option value={form.fields.type}>{form.fields.type}</option>}</select></label>
					{form.fields.type === "stdio" ? <>
						<label>{t("mcpCommand")}<input value={form.fields.command} autoComplete="off" spellCheck={false} onChange={event => updateForm("command", event.target.value)} /></label>
						<label>{t("ompMcpCwd")}<input value={form.fields.cwd} autoComplete="off" spellCheck={false} onChange={event => updateForm("cwd", event.target.value)} /></label>
						<label>{t("mcpArgs")}<textarea aria-label={t("mcpArgs")} value={form.fields.args} autoComplete="off" spellCheck={false} onChange={event => updateForm("args", event.target.value)} /></label>
						<label>{t("mcpEnv")}<textarea aria-label={t("mcpEnv")} value={form.fields.env} autoComplete="off" spellCheck={false} onChange={event => updateForm("env", event.target.value)} /></label>
					</> : <>
						<label>{t("ompMcpUrl")}<input value={form.fields.url} autoComplete="off" spellCheck={false} onChange={event => updateForm("url", event.target.value)} /></label>
						<label>{t("mcpHeaders")}<textarea aria-label={t("mcpHeaders")} value={form.fields.headers} autoComplete="off" spellCheck={false} onChange={event => updateForm("headers", event.target.value)} /></label>
					</>}
					<label>{t("ompMcpTimeout")}<input type="number" min="0" step="any" value={form.fields.timeout} onChange={event => updateForm("timeout", event.target.value)} /></label>
					<label>{t("mcpEnabled")}<select aria-label={t("mcpEnabled")} value={form.fields.enabled} onChange={event => updateForm("enabled", event.target.value)}><option value="">{t("ompMcpNativeDefault")}</option><option value="true">{t("ompMcpEnable")}</option><option value="false">{t("ompMcpDisable")}</option></select></label>
					<p className="settings-intro">{t(scope === "global" ? "ompMcpGlobalEnableHelp" : "ompMcpProjectEnableHelp")}</p>
					<div className="omp-mcp-actions"><button className="btn primary" type="submit">{t("ompMcpSaveServer")}</button><button className="btn" type="button" onClick={closeForm}>{t("cancel")}</button></div>
				</fieldset>
			</form>}
		</div>}
		{config && <details className="omp-mcp-editor" open={editorOpen} onToggle={event => setEditorOpen(event.currentTarget.open)}><summary>{t("mcpConfig")}</summary>
			<p className="settings-intro">{t("ompMcpJsonHelp")}</p>
			<textarea aria-label={t("mcpConfig")} spellCheck={false} value={draft} disabled={loading || !!form || !!importDraft} onChange={event => setDraft(event.target.value)} />
			<button className="btn primary" disabled={writeDisabled || !jsonDirty || !!form || !!importDraft} onClick={() => void request("save")}>{t("ompMcpSave")}</button>
			<code className="omp-mcp-path">{config.path}</code>
		</details>}
		{runtime?.auth && <div className="settings-group omp-mcp-auth" aria-label={t("ompMcpAuthTitle")}>
			<p role="status">{runtime.auth.name}: {t(runtime.auth.status === "pending" ? "ompMcpAuthPending" : runtime.auth.status === "complete" ? "ompMcpAuthComplete" : runtime.auth.status === "cancelled" ? "ompMcpAuthCancelled" : runtime.auth.status === "signed_out" ? "ompMcpAuthSignedOut" : runtime.auth.status === "configuration_changed" ? "ompMcpAuthChanged" : "ompMcpAuthFailed")}</p>
			{authBusy && <>
				{runtime.auth.url && <a className="btn sm" href={runtime.auth.url} target="_blank" rel="noopener noreferrer">{t("ompMcpAuthOpen")}</a>}
				{runtime.auth.inputRequired && <form onSubmit={event => { event.preventDefault(); void request("auth_input"); }}>
					<label>{t("ompMcpAuthInput")}<input type="password" autoComplete="off" value={authInput} onChange={event => setAuthInput(event.target.value)} /></label>
					<button className="btn sm" disabled={loading || !authInput.trim()}>{t("ompMcpAuthSubmit")}</button>
				</form>}
				<button className="btn sm" disabled={loading} onClick={() => void request("auth_cancel")}>{t("cancel")}</button>
			</>}
		</div>}
		<h4>{t("ompMcpLive")}</h4>
		<div className="settings-group">{runtime?.servers.map(server => <div className="omp-mcp-server" key={server.name}>
			<strong>{server.name}</strong><span>{t(server.status === "connected" ? "mcpConnected" : server.status === "connecting" ? "mcpConnecting" : "mcpDisconnected")}</span>
			{server.failure && <OmpMcpFailure failure={server.failure} />}
			<button className="btn sm" disabled={busy || loading || dirty || !!form || !!importDraft || authBusy || server.status === "connecting"} onClick={() => void request("reconnect", server.name)}>{t("ompMcpReconnect")}</button>
			{server.oauthAvailable && <div className="omp-mcp-actions">
				<span>{t(server.authenticated ? "ompMcpAuthStored" : "ompMcpAuthMissing")}</span>
				<button className="btn sm" disabled={busy || loading || dirty || !!form || !!importDraft || authBusy} onClick={() => void request("login", server.name)}>{t("ompMcpAuthLogin")}</button>
				<button className="btn sm" disabled={busy || loading || dirty || !!form || !!importDraft || authBusy || !server.authenticated} onClick={() => { if (window.confirm(t("ompMcpAuthLogoutConfirm"))) void request("logout", server.name); }}>{t("ompMcpAuthLogout")}</button>
			</div>}
			{server.source && <code className="omp-mcp-path">{server.source}</code>}
			{server.tools.length > 0 && <details><summary>{t("ompMcpToolsCount", { n: server.tools.length })}</summary>{server.tools.map(tool => <code className="omp-mcp-tool" key={tool}>{tool}</code>)}</details>}
		</div>)}{!runtime?.servers.length && <p className="settings-empty">{t(loading ? "loading" : "ompMcpEmpty")}</p>}</div>
		{runtime?.diagnostics && <OmpMcpDiagnostics diagnostics={runtime.diagnostics} />}
	</section>;
}
