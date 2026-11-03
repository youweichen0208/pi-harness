import { isTopDialog, useDialogFocus } from "../use-dialog-focus";
import { useEffect, useState } from "react";
import type { ClientMessage, ProviderAuthState } from "../types";
import { useT } from "../i18n";

export function ProviderAuthModal({ state, send }: { state: ProviderAuthState | null; send: (message: ClientMessage) => boolean }) {
	const t = useT();
	const [copyResult, setCopyResult] = useState<{ requestId: string; code: string; ok: boolean } | null>(null);
	const [value, setValue] = useState("");
	const [dismissed, setDismissed] = useState<string | null>(null);
	const dialogRef = useDialogFocus<HTMLElement>(!!state && dismissed !== state.requestId);
	useEffect(() => { setValue(""); }, [state?.requestId, state?.prompt?.id]);
	useEffect(() => {
		if (!state || dismissed === state.requestId) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !isTopDialog(dialogRef.current)) return;
			event.preventDefault();
			if (state.phase === "pending") send({ type: "cancel_provider_login", requestId: state.requestId });
			setDismissed(state.requestId);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [state, dismissed, send]);
	if (!state || dismissed === state.requestId) return null;
	let url: string | undefined;
	try { const parsed = new URL(state.url ?? ""); if (parsed.protocol === "https:" || parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) url = parsed.href; } catch {}
	const copyCode = !!state.code && state.copyCodeOnConfirm !== false;
	const openBrowser = !!url && state.openBrowserOnConfirm !== false;
	const confirmDevice = () => {
		// Keep both operations in the user gesture; never open a popup after awaiting clipboard access.
		if (copyCode && state.code) {
			const code = state.code;
			void (async () => {
				try { await navigator.clipboard.writeText(code); setCopyResult({ requestId: state.requestId, code, ok: true }); }
				catch { setCopyResult({ requestId: state.requestId, code, ok: false }); }
			})();
		}
		if (openBrowser) window.open(url, "_blank", "noopener,noreferrer");
	};
	const close = () => { if (state.phase === "pending") send({ type: "cancel_provider_login", requestId: state.requestId }); setDismissed(state.requestId); };
	return <div className="modal-backdrop provider-auth-backdrop"><section className="modal provider-auth-modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="provider-auth-title">
		<div className="modal-head"><h2 id="provider-auth-title">{t("providerLogin")} · {state.provider}</h2><button className="iconbtn" onClick={close} aria-label={t("close")}>×</button></div>
		<div className="modal-body">
			<p>{t(state.phase === "pending" ? "providerAuthPending" : state.phase === "success" ? "providerAuthSuccess" : state.phase === "cancelled" ? "providerAuthCancelled" : "providerAuthError")}</p>
			{state.message && <p className="provider-auth-message">{state.message}</p>}
			{url && !state.code && <a className="btn" href={url} target="_blank" rel="noreferrer">{t("providerAuthOpenBrowser")}</a>}
			{state.phase === "success" && state.provider === "radius" && <button className="btn" onClick={() => window.dispatchEvent(new Event("pi-configure-radius"))}>{t("mcpConfigureRadius")}</button>}
			{state.code && <p>{t("providerAuthDeviceCode")} <code>{state.code}</code></p>}
			{state.phase === "pending" && state.code && (copyCode || openBrowser) && <button className="btn provider-auth-device-confirm" onClick={confirmDevice}>{t(copyCode ? openBrowser ? "providerAuthCopyAndOpen" : "providerAuthCopyCode" : "providerAuthOpenBrowser")}</button>}
			{state.code && copyResult?.requestId === state.requestId && copyResult.code === state.code && <p role="status">{t(copyResult.ok ? "providerAuthCopied" : "providerAuthCopyFailed")}</p>}
			{state.prompt && <form key={state.prompt.id} onSubmit={event => { event.preventDefault(); if (state.prompt) send({ type: "provider_auth_response", requestId: state.requestId, promptId: state.prompt.id, value }); setValue(""); }}>
				<label>{state.prompt.message}{state.prompt.kind === "select" ? <select value={value} onChange={event => setValue(event.target.value)}><option value="">{t("providerAuthChoose")}</option>{state.prompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : <input autoFocus type={state.prompt.kind === "secret" ? "password" : "text"} value={value} onChange={event => setValue(event.target.value)} placeholder={state.prompt.placeholder} autoComplete="off" />}</label>
				<button type="submit" className="btn" disabled={!value}>{t("confirm")}</button>
			</form>}
		</div>
		<div className="modal-actions"><button className="btn" onClick={close}>{t(state.phase === "pending" ? "cancel" : "close")}</button></div>
	</section></div>;
}
