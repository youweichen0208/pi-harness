import { isTopDialog, useDialogFocus } from "../use-dialog-focus";
import { useEffect, useState } from "react";
import type { ClientMessage, ProviderAuthState } from "../types";
import { FiExternalLink, FiX, FiLogIn, FiCheck } from "react-icons/fi";
import { useT } from "../i18n";

export function ProviderAuthModal({ state, send }: { state: ProviderAuthState | null; send: (message: ClientMessage) => boolean }) {
	const t = useT();
	const [copyResult, setCopyResult] = useState<{ requestId: string; code: string; ok: boolean } | null>(null);
	const [value, setValue] = useState("");
	const [openedRequest, setOpenedRequest] = useState<string | null>(null);
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
	const callbackPrompt = state.provider === "openai" && state.prompt?.kind === "manual_code" && /redirect URL/i.test(state.prompt.message);
	const redundantMessage = callbackPrompt && state.phase === "pending" && /^Complete sign-in in your browser\./.test(state.message ?? "");
	const browserFlow = state.phase === "pending" && !!url && !state.code;
	const deviceFlow = state.phase === "pending" && !!state.code && (copyCode || openBrowser);
	const deviceCopyResult = copyResult?.requestId === state.requestId && copyResult.code === state.code ? copyResult : null;
	const providerName = state.provider === "openai" ? "ChatGPT" : state.provider === "kimi-coding" ? "Kimi" : state.provider;
	const close = () => { if (state.phase === "pending") send({ type: "cancel_provider_login", requestId: state.requestId }); setDismissed(state.requestId); };
	return <div className="modal-backdrop provider-auth-backdrop"><section className="modal provider-auth-modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="provider-auth-title" aria-describedby="provider-auth-status">
		<div className="modal-head"><div className="provider-auth-heading"><span className="provider-auth-symbol" aria-hidden="true"><FiLogIn /></span><h2 id="provider-auth-title">{t("providerAuthTitle", { provider: providerName })}</h2></div><button className="iconbtn" onClick={close} aria-label={t("close")}><FiX aria-hidden="true" /></button></div>
		<div className="modal-body">
			<p id="provider-auth-status" className="provider-auth-status" role="status">{deviceFlow && copyCode && openBrowser ? t("providerAuthDeviceIntro") : browserFlow ? t(openedRequest === state.requestId ? "providerAuthBrowserWaiting" : "providerAuthBrowserIntro") : t(state.phase === "pending" ? "providerAuthPending" : state.phase === "success" ? "providerAuthSuccess" : state.phase === "cancelled" ? "providerAuthCancelled" : "providerAuthError")}</p>
			{state.message && !redundantMessage && <p className="provider-auth-message">{state.message}</p>}
			{url && !state.code && <div className="provider-auth-actions"><a className="btn primary provider-auth-open" href={url} onClick={() => setOpenedRequest(state.requestId)} target="_blank" rel="noreferrer">{t(openedRequest === state.requestId ? "providerAuthReopen" : "providerAuthContinue")}<FiExternalLink aria-hidden="true" /></a>{browserFlow && <button className="btn provider-auth-cancel" onClick={close}>{t("cancel")}</button>}</div>}
			{state.phase === "success" && state.provider === "radius" && <button className="btn" onClick={() => window.dispatchEvent(new Event("pi-configure-radius"))}>{t("mcpConfigureRadius")}</button>}
			{state.code && <div className="provider-auth-code-card">
				<span className="provider-auth-code-label">{t("providerAuthDeviceCode")}</span>
				<code>{state.code}</code>
				<div className="provider-auth-copy-status" role="status" aria-live="polite">
					{deviceCopyResult && <>{deviceCopyResult.ok && <FiCheck aria-hidden="true" />}{t(deviceCopyResult.ok ? "providerAuthCopied" : "providerAuthCopyFailed")}</>}
				</div>
			</div>}
			{deviceFlow && <div className="provider-auth-actions">
				<button className="btn primary provider-auth-device-confirm" onClick={confirmDevice}>{t(copyCode ? openBrowser ? "providerAuthCopyAndOpen" : "providerAuthCopyCode" : "providerAuthOpenBrowser")}{openBrowser && <FiExternalLink aria-hidden="true" />}</button>
				<button className="btn provider-auth-cancel" onClick={close}>{t("cancel")}</button>
			</div>}
			{state.prompt && !callbackPrompt && <div className="provider-auth-fallback" key={state.prompt.id}>
				<form onSubmit={event => { event.preventDefault(); if (state.prompt) send({ type: "provider_auth_response", requestId: state.requestId, promptId: state.prompt.id, value }); setValue(""); }}>
				<label>{state.prompt.message}{state.prompt.kind === "select" ? <select value={value} onChange={event => setValue(event.target.value)}><option value="">{t("providerAuthChoose")}</option>{state.prompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : <input type={state.prompt.kind === "secret" ? "password" : "text"} value={value} onChange={event => setValue(event.target.value)} placeholder={state.prompt.placeholder} autoComplete="off" />}</label>
				<button type="submit" className="btn" disabled={!value.trim()}>{t("confirm")}</button>
			</form></div>}
		</div>
		{!browserFlow && !deviceFlow && <div className="modal-actions"><button className="btn" onClick={close}>{t(state.phase === "pending" ? "cancel" : "close")}</button></div>}
	</section></div>;
}
