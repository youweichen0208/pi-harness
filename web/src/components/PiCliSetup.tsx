import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import type { PiCliStatus, CliToolStatus } from "../types";
import { PI_CLI_INSTALL_COMMAND } from "../pi-cli-install";

export function PiCliSetup({ cwd, ready, onInstall }: { cwd: string; ready: boolean; onInstall: () => void }) {
	const t = useT();
	const [attempt, setAttempt] = useState(0);
	const [status, setStatus] = useState<PiCliStatus>();
	const [error, setError] = useState("");
	useEffect(() => {
		const abort = new AbortController();
		setStatus(undefined); setError("");
		if (ready) void (async () => {
			try {
				const response = await fetch(withToken("/api/extensions"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cli-status", clientId: getClientId(), cwd }), signal: abort.signal });
				if (!response.ok) throw Error(t("piCliCheckFailed"));
				const result: PiCliStatus = await response.json();
				if (!abort.signal.aborted) setStatus(result);
			} catch (error) { if (!abort.signal.aborted) setError((error as Error).message); }
		})();
		return () => abort.abort();
	}, [cwd, ready, attempt, t]);
	const label = (tool: CliToolStatus) => tool.status === "available" ? tool.version : t(tool.status === "missing" ? "piCliMissing" : "piCliUnusable");
	return <section className="ext-local-directory pi-cli-setup" aria-label="Pi CLI">
		<strong>Pi CLI</strong>
		<p className="ext-muted">{t("piCliHint")}</p>
		{error ? <p role="alert" className="ext-error">{error}</p> : status ? <p role="status">Pi: {label(status.pi)} · Node.js: {label(status.node)} · npm: {label(status.npm)}</p> : <p role="status">{t(ready ? "loading" : "piCliDisconnected")}</p>}
		{status?.pi.status === "missing" && <>
			<code className="ext-source">{PI_CLI_INSTALL_COMMAND}</code>
			{!status.canInstall && <p className="ext-muted">{t("piCliDependencies")} <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">Node.js</a></p>}
		</>}
		{status?.pi.status !== "available" && <p className="ext-muted">{t("piCliTroubleshoot")}</p>}
		<div className="ext-actions">
			{status?.pi.status === "missing" && <button disabled={!ready || !status.canInstall} onClick={onInstall}>{t("piCliInstall")}</button>}
			<button disabled={!ready || !status && !error} onClick={() => setAttempt(value => value + 1)}>{t("piCliCheck")}</button>
			<a href="https://pi.dev/docs/latest/quickstart" target="_blank" rel="noreferrer">{t("piCliDocs")}</a>
		</div>
	</section>;
}
