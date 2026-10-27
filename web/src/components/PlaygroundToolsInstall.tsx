import { useEffect, useRef, useState } from "react";
import { withToken } from "../auth-token";
import { useT } from "../i18n";

export function PlaygroundToolsInstall({ available }: { available: boolean }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [done, setDone] = useState(false);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	const install = async () => {
		if (controller.current) return;
		const pending = new AbortController(); controller.current = pending;
		setBusy(true); setError(""); setDone(false);
		try {
			const response = await fetch(withToken("/api/playground/tools/install"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: pending.signal });
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || t("pgToolsInstallFailed"));
			setDone(true);
			window.dispatchEvent(new Event("pi-harness:python-tools-installed"));
		} catch (error) {
			if (!pending.signal.aborted) setError(error instanceof Error ? error.message : String(error));
		} finally {
			controller.current = null;
			if (!pending.signal.aborted) setBusy(false);
		}
	};
	return <div className="playground-tools-install">
		<p className="playground-hint">{t("pgToolsInstallHint")}</p>
		<button type="button" className="btn" disabled={!available || busy} onClick={() => void install()}>{t(busy ? "pgToolsInstalling" : "pgToolsInstall")}</button>
		<span role="status" aria-live="polite">{busy ? t("pgToolsInstallingHint") : done ? t("pgToolsInstalled") : ""}</span>
		{error && <p className="playground-error" role="alert">{t("pgToolsInstallFailed")} {error}</p>}
	</div>;
}
