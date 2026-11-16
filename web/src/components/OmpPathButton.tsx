import { useEffect, useRef, useState } from "react";
import { desktopAPI } from "../desktop";
import { copyText } from "../clipboard";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { useT } from "../i18n";
import type { OmpPathTarget, UiOmpPath } from "../types";

async function resolvePath(cwd: string, conversationId: string, target: OmpPathTarget, prepare: boolean, signal: AbortSignal): Promise<UiOmpPath> {
	const response = await fetch(withToken("/api/omp-paths"), { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: getClientId(), cwd, conversationId, target, prepare }) });
	if (!response.ok) throw Error("OMP path unavailable");
	return response.json();
}

export function OmpPathButton({ cwd, conversationId, target }: { cwd: string; conversationId: string; target: OmpPathTarget }) {
	const t = useT();
	const [busy, setBusy] = useState(false), [error, setError] = useState(false), [copied, setCopied] = useState(false);
	const pending = useRef<AbortController>();
	useEffect(() => () => { pending.current?.abort(); pending.current = undefined; }, []);
	async function open(doc: Document) {
		if (pending.current) return;
		const controller = new AbortController(); pending.current = controller;
		setBusy(true); setError(false); setCopied(false);
		const timer = setTimeout(() => controller.abort(), 15000);
		try {
			if (desktopAPI?.openOmpPath) await desktopAPI.openOmpPath({ clientId: getClientId(), cwd, conversationId, target });
			else {
				const path = await resolvePath(cwd, conversationId, target, true, controller.signal);
				if (controller.signal.aborted) return;
				await copyText(path.absolute, doc);
				if (!controller.signal.aborted) setCopied(true);
			}
		} catch { if (pending.current === controller) setError(true); }
		finally { clearTimeout(timer); if (pending.current === controller) { pending.current = undefined; setBusy(false); } }
	}
	const personal = target.kind === "extensions";
	return <span className="omp-path-control">
		<button className="btn" disabled={busy} onClick={event => void open(event.currentTarget.ownerDocument)}>{t(desktopAPI?.openOmpPath ? personal ? "extLocalOpen" : "extOpen" : personal ? "extLocalCopy" : "extCopyPath")}</button>
		{copied && <small role="status">{t("promptCopied")}</small>}
		{error && <small role="alert" className="settings-error">{t("ompPathUnavailable")}</small>}
	</span>;
}

export function OmpExtensionDirectory({ cwd, conversationId }: { cwd: string; conversationId: string }) {
	const t = useT();
	const [path, setPath] = useState<string>(), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const controller = new AbortController(); let active = true;
		const timer = setTimeout(() => controller.abort(), 15000);
		setError(false);
		void resolvePath(cwd, conversationId, { kind: "extensions" }, false, controller.signal).then(value => { if (active) setPath(value.absolute); }).catch(() => { if (active) setError(true); }).finally(() => clearTimeout(timer));
		return () => { active = false; controller.abort(); clearTimeout(timer); };
	}, [cwd, conversationId, attempt]);
	return <section className="omp-extension-directory" aria-label={t("extLocalTitle")}>
		<h3>{t("extLocalTitle")}</h3>
		<p className="settings-intro">{t("ompLocalHint")}</p>
		{path && <code>{path}</code>}
		{error && <p className="settings-error" role="alert">{t("ompPathUnavailable")} <button onClick={() => setAttempt(value => value + 1)}>{t("extRetry")}</button></p>}
		<OmpPathButton cwd={cwd} conversationId={conversationId} target={{ kind: "extensions" }} />
	</section>;
}
