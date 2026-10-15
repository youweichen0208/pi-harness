import { useEffect, useState } from "react";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import type { OpenAIProxyState } from "../types";

export function OpenAIProxySettings() {
	const t = useT();
	const [state, setState] = useState<OpenAIProxyState | null>(null);
	const [enabled, setEnabled] = useState(false), [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		void request({ action: "get" }, controller.signal).then(result => {
			if (controller.signal.aborted) return;
			setState(result); setEnabled(result.enabled); setUrl(result.url);
		}).catch(error => { if (!controller.signal.aborted) setError(error.message); });
		return () => controller.abort();
	}, []);
	async function request(body: object, signal?: AbortSignal): Promise<OpenAIProxyState> {
		const response = await fetch(withToken("/api/openai-proxy"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
		const data = await response.json();
		if (!response.ok) throw Error(data.error || response.statusText);
		return data;
	}
	async function save() {
		if (!state || busy) return;
		setBusy(true); setError(""); setSaved(false);
		try {
			const result = await request({ action: "save", version: state.version, config: { enabled, url } });
			setState(result); setUrl(result.url); setSaved(true);
		} catch (error) { setError((error as Error).message); }
		finally { setBusy(false); }
	}
	return <details className="openai-proxy-settings" aria-label={t("openaiProxyTitle")}>
		<summary tabIndex={0}>{t("openaiProxyTitle")} · {t(!state ? "loading" : state.enabled ? "providerProxyEnabled" : "providerProxyDisabled")}{state?.restartRequired && <span> · {t("openaiProxyRestart")}</span>}{error && <span> · {t("providerProxyError")}</span>}</summary>
		<p>{t("openaiProxyDescription")}</p>
		<label><input type="checkbox" checked={enabled} disabled={!state || busy} onChange={event => { setEnabled(event.target.checked); setSaved(false); }} />{t("openaiProxyEnable")}</label>
		<label className="openai-proxy-address">{t("openaiProxyAddress")}
			<input type="url" value={url} disabled={!state || busy} placeholder={t("openaiProxyPlaceholder")} spellCheck={false} autoComplete="off" onChange={event => { setUrl(event.target.value); setSaved(false); }} />
		</label>
		<p>{t("openaiProxyHint")}</p>
		<button type="button" className="btn sm" disabled={!state || busy || (enabled && !url.trim())} onClick={() => void save()}>{t(busy ? "saving" : "save")}</button>
		{(saved || state?.restartRequired) && <p role="status">{t(state?.restartRequired ? "openaiProxyRestart" : "openaiProxySaved")}</p>}
		{error && <p className="openai-proxy-error" role="alert">{error}</p>}
	</details>;
}
