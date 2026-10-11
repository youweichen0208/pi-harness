import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import type { BuiltinExtensionId, BuiltinExtensionsRequest, BuiltinExtensionsState, PlanSettingsState } from "../types";

const labels = {
	"pi-harness-okf": ["builtinOkf", "builtinOkfHint"],
	"pi-harness-plan": ["builtinPlan", "builtinPlanHint"],
	mcp: ["builtinMcp", "builtinMcpHint"],
	codemode: ["builtinCodemode", "builtinCodemodeHint"],
	"tool-search": ["builtinSearch", "builtinSearchHint"],
} as const;
const examples: Partial<Record<BuiltinExtensionId, string[]>> = {
	"pi-harness-okf": ["/okf ingest ./raw", "/okf status", "/okf settings"],
};

export function BuiltinExtensionsPanel({ cwd, conversationId, ready, canReload, plan, togglePlan, reload, openNative }: {
	cwd: string; conversationId: string; ready: boolean; canReload: boolean; plan?: PlanSettingsState;
	togglePlan: (enabled: boolean) => void; reload: () => void; openNative: () => void;
}) {
	const t = useT();
	const [state, setState] = useState<BuiltinExtensionsState>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState("");
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
	async function copy(command: string) {
		try { await navigator.clipboard.writeText(command); setCopied(command); }
		catch (e) { setError((e as Error).message); }
	}
	return <section className="builtin-extensions" aria-label={t("builtinTitle")}>
		<h3 className="settings-group-title">{t("builtinTitle")} · {state?.items.length ?? "…"}<small>{t("builtinBundled")}</small></h3>
		{error && <div role="alert" className="ext-error">{error} <button disabled={busy || !ready} onClick={() => { setError(""); void refresh(); }}>{t("extRefresh")}</button></div>}
		{!state && <p>{t("loading")}</p>}
		<div className="ext-list">{state?.items.map(item => {
			const [title, description] = labels[item.id];
			const planItem = item.id === "pi-harness-plan" ? plan : undefined;
			const status = planItem ? !planItem.available ? "unavailable" : planItem.pending ? "pending" : planItem.effective ? "loaded" : "disabled" : item.status;
			const documentItem = item.id === "pi-harness-okf";
			return <article className="ext-row builtin-row" key={item.id} data-builtin-id={item.id}>
				<div className="builtin-row-head"><div><strong>{t(title)}</strong><p className="settings-description">{t(description)}</p></div>
					<span className="builtin-status" data-status={status}>{t(({ loaded: "builtinLoaded", disabled: "builtinDisabled", pending: "builtinPending", unavailable: "builtinUnavailable", error: "builtinError" } as const)[status])}</span>
					{documentItem ? <input className="ext-switch" type="checkbox" role="switch" aria-label={`${t("extEnable")} ${t(title)}`} checked={item.enabled ?? false} disabled={busy || !ready || !state.documentVersion || item.enabled === undefined} onChange={event => void change({ action: "builtin-toggle", conversationId, id: item.id as "pi-harness-okf", enabled: event.target.checked, version: state.documentVersion! })} />
						: planItem ? <input className="ext-switch" type="checkbox" role="switch" aria-label={t("planEnabled")} checked={planItem.enabled} disabled={!ready} onChange={event => togglePlan(event.target.checked)} />
						: item.id !== "pi-harness-plan" && <button onClick={openNative}>{t("builtinSettings")}</button>}
				</div>
				{item.error && <p className="ext-error">{item.error}</p>}
				{item.reason && <p className="settings-description">{t(item.reason === "conflict" ? "builtinConflict" : item.reason === "filtered" ? "builtinFiltered" : "builtinMissing")}</p>}
				{status === "pending" && <p className="settings-description">{t(planItem ? "planPending" : "builtinReloadHint")}</p>}
				<details><summary>{t("extDetails")}</summary>
					{(documentItem || planItem) && <p>{t(planItem ? "planEnabledHint" : "builtinDocumentScope")}</p>}
					<p>{t("builtinTools")}: <code>{item.tools.join(", ") || "—"}</code></p>
					{item.commands.length > 0 && <p>{t("builtinCommands")}: <code>{item.commands.map(command => `/${command}`).join(", ")}</code></p>}
					{examples[item.id]?.map(command => <div className="builtin-command" key={command}><code>{command}</code><button onClick={() => void copy(command)}>{t(copied === command ? "builtinCopied" : "builtinCopy")}</button></div>)}
					{documentItem && <button disabled={busy || !ready || !canReload || !state.canReload} onClick={reload}>{t("extReload")}</button>}
				</details>
			</article>;
		})}</div>
	</section>;
}
