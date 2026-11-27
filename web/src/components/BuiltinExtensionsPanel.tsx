import { useEffect, useRef, useState } from "react";
import { FiMonitor, FiServer, FiCode, FiSearch } from "react-icons/fi";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import type { BuiltinExtensionsRequest, BuiltinExtensionsState } from "../types";

const labels = {
	"background-bash": ["backgroundTitle", "backgroundHint"],
	"desktop-control": ["desktopControl", "desktopControlHint"],
	mcp: ["builtinMcp", "builtinMcpHint"],
	codemode: ["builtinCodemode", "builtinCodemodeHint"],
	"tool-search": ["builtinSearch", "builtinSearchHint"],
} as const;

const icons = { "background-bash": FiCode, "desktop-control": FiMonitor, mcp: FiServer, codemode: FiCode, "tool-search": FiSearch };

export function BuiltinExtensionsPanel({ cwd, conversationId, ready, canReload, reload, openNative }: {
	cwd: string; conversationId: string; ready: boolean; canReload: boolean;
	reload: () => void; openNative: () => void;
}) {
	const t = useT();
	const [state, setState] = useState<BuiltinExtensionsState>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const life = useRef<AbortController>();
	const working = useRef(false);
	const sequence = useRef(0);
	async function request<T>(body: BuiltinExtensionsRequest): Promise<T> {
		const response = await fetch(withToken("/api/extensions"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, cwd, clientId: getClientId() }), signal: life.current?.signal });
		const result = await response.json();
		if (!response.ok) throw Error(result.error ?? response.statusText);
		return result;
	}
	async function refresh() {
		if (!ready || working.current) return;
		const current = ++sequence.current;
		try {
			const next = await request<BuiltinExtensionsState>({ action: "builtin-list", conversationId });
			if (!life.current?.signal.aborted && current === sequence.current) setState(next);
		} catch (e) { if (!life.current?.signal.aborted && current === sequence.current) setError((e as Error).message); }
	}
	useEffect(() => {
		const controller = new AbortController(); life.current = controller;
		void refresh();
		const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
		return () => { controller.abort(); clearInterval(timer); sequence.current++; };
	}, [cwd, conversationId, ready]);
	async function change(body: BuiltinExtensionsRequest) {
		if (working.current || !ready) return;
		working.current = true; const current = ++sequence.current; setBusy(true); setError("");
		try {
			const next = await request<BuiltinExtensionsState>(body);
			if (!life.current?.signal.aborted && current === sequence.current) setState(next);
		} catch (e) { if (!life.current?.signal.aborted && current === sequence.current) setError((e as Error).message); }
		finally { working.current = false; if (!life.current?.signal.aborted) { setBusy(false); } }
	}
	const items = state?.items.filter(item => Object.hasOwn(labels, item.id) && Object.hasOwn(icons, item.id));
	return <section className="builtin-extensions" aria-label={t("builtinTitle")}>
		<h3 className="settings-group-title">{t("builtinTitle")} · {items ? items.length : "…"}<small>{t("builtinBundled")}</small></h3>
		{error && <div role="alert" className="ext-error">{error} <button disabled={busy || !ready} onClick={() => { setError(""); void refresh(); }}>{t("extRefresh")}</button></div>}
		{!state && <p>{t("loading")}</p>}
		<div className="ext-list">
			{items?.map(item => {
			const [title, description] = labels[item.id];
			const Icon = icons[item.id];
			const status = item.status;
			const toggleableItem = item.id === "background-bash" || item.id === "desktop-control";
			const version = item.settingsVersion ?? state?.documentVersion;
			return <article className="ext-row builtin-row" key={item.id} data-builtin-id={item.id}>
				<span className="builtin-icon" aria-hidden="true"><Icon /></span><div className="builtin-row-content"><div className="builtin-row-head"><div><strong>{t(title)}</strong><p className="settings-description">{t(description)}</p></div>
					<span className="builtin-status" data-status={status}>{t(({ loaded: "builtinLoaded", disabled: "builtinDisabled", pending: "builtinPending", unavailable: "builtinUnavailable", error: "builtinError" } as const)[status])}</span>
					{toggleableItem ? <input className="ext-switch" type="checkbox" role="switch" aria-label={`${t("extEnable")} ${t(title)}`} checked={item.enabled ?? false} disabled={busy || !ready || !version || item.enabled === undefined} onChange={event => void change({ action: "builtin-toggle", conversationId, id: item.id as "background-bash" | "desktop-control", enabled: event.target.checked, version: version! })} />
						: <button onClick={openNative}>{t("builtinSettings")}</button>}
				</div>
				{item.id === "desktop-control" && state?.documentVersion && <label className="builtin-default"><input className="ext-switch" type="checkbox" role="switch" aria-label={t("desktopDefaultOn")} checked={item.desktopDefault ?? false} disabled={busy || !ready} onChange={event => void change({ action: "builtin-toggle", conversationId, id: "desktop-control", enabled: event.target.checked, version: state.documentVersion! })} /><span>{t("desktopDefaultOn")}</span><small className="settings-description">{t("desktopDefaultOnHint")}</small></label>}
				{item.helperInstalled === false && <p className="settings-description">{t("desktopHelperMissing")}</p>}
				{item.error && <p className="ext-error">{item.error}</p>}
				{item.reason && <p className="settings-description">{t(item.reason === "conflict" ? "builtinConflict" : item.reason === "filtered" ? "builtinFiltered" : "builtinMissing")}</p>}
				{status === "pending" && <p className="settings-description">{t("builtinReloadHint")}</p>}
				<details><summary>{t("extDetails")}</summary>
					<p>{t("builtinTools")}: <code>{item.tools.join(", ") || "—"}</code></p>
					{item.commands.length > 0 && <p>{t("builtinCommands")}: <code>{item.commands.map(command => `/${command}`).join(", ")}</code></p>}
					{toggleableItem && item.id !== "desktop-control" && <button disabled={busy || !ready || !canReload || !state?.canReload} onClick={reload}>{t("extReload")}</button>}
				</details></div>
			</article>;
		})}</div>
	</section>;
}
