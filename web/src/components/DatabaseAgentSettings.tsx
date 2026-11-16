import { useEffect, useId, useRef, useState } from "react";
import { databaseRequest } from "../database-api";
import { useT } from "../i18n";
import type { DatabaseOperation, DatabaseResponse } from "../types";

export function DatabaseAgentSettings({ cwd, conversationId }: { cwd: string; conversationId: string }) {
	const t = useT(), id = useId();
	const [settings, setSettings] = useState<DatabaseResponse["agentSettings"]>();
	const [busy, setBusy] = useState<"explicit" | "poll">(), [error, setError] = useState("");
	const pending = useRef<AbortController>(), fault = useRef(false);
	const request = async (operation: DatabaseOperation = { action: "agent_settings" }, quiet = false) => {
		if (pending.current) return;
		const controller = new AbortController(); pending.current = controller;
		setBusy(quiet ? "poll" : "explicit"); setError(""); fault.current = false;
		const timeout = setTimeout(() => {
			if (pending.current !== controller) return;
			pending.current = undefined; controller.abort(); fault.current = true;
			setError("DATABASE_AGENT_SETTINGS_UNAVAILABLE"); setBusy(undefined);
		}, 10000);
		try {
			const result = await databaseRequest(cwd, conversationId, operation, controller.signal);
			if (controller.signal.aborted || pending.current !== controller) return;
			if (!result.agentSettings || typeof result.agentSettings.enabled !== "boolean" || typeof result.agentSettings.version !== "string") throw Error("DATABASE_AGENT_SETTINGS_UNAVAILABLE");
			setSettings(result.agentSettings);
		} catch (error) {
			if (!controller.signal.aborted && pending.current === controller) { fault.current = true; setError((error as Error).message); }
		} finally {
			clearTimeout(timeout);
			if (pending.current === controller) { pending.current = undefined; setBusy(undefined); }
		}
	};
	useEffect(() => {
		setSettings(undefined); fault.current = false;
		const refresh = () => { if (!fault.current && !document.hidden) void request(undefined, true); };
		void request();
		const interval = setInterval(refresh, 5000);
		window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
		return () => { clearInterval(interval); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); const controller = pending.current; pending.current = undefined; controller?.abort(); };
	}, [cwd, conversationId]);
	return <section className="database-agent-settings" aria-label={t("dbAgentSettingsTitle")}>
		<h3 className="settings-group-title">{t("dbAgentSettingsTitle")}</h3>
		<div className="settings-group"><label className="settings-list-row">
			<span>{t("dbAgentEnabled")}</span>
			<input className="settings-switch" type="checkbox" role="switch" checked={settings?.enabled ?? false} disabled={!!busy || !settings || !!error} aria-describedby={`${id}-hint`} onChange={event => { if (settings) void request({ action: "set_agent_settings", enabled: event.target.checked, version: settings.version }); }} />
		</label></div>
		<p id={`${id}-hint`} className="settings-intro">{t("dbAgentSettingsHint")}</p>
		{busy === "explicit" && <p className="settings-readonly" role="status">{t("loading")}</p>}
		{error && <p className="settings-error" role="alert">{t(error === "DATABASE_AGENT_SETTINGS_CONFLICT" ? "dbAgentSettingsConflict" : "dbAgentSettingsUnavailable")}</p>}
		<button className="btn sm" type="button" disabled={!!busy} onClick={() => void request()}>{t("dbAgentSettingsRefresh")}</button>
	</section>;
}
