import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import type { ClientMessage, MissingSessionSummary, ServerMessage } from "../types";
import { useT } from "../i18n";
import { randomUuid } from "../uuid";
import { useDialogFocus } from "../use-dialog-focus";
import { skillAwarePreview } from "../skill-block";

type Request = Extract<ClientMessage, { type: "list_missing_sessions" | "recover_missing_session" }>;
export interface MissingSessionRecoveryProps {
	cwd: string;
	conversationId: string;
	ready: boolean;
	send: (message: Request) => boolean;
	listing: Extract<ServerMessage, { type: "missing_sessions" }> | null;
	result: Extract<ServerMessage, { type: "missing_session_result" }> | null;
}

/** Discover on connection/context changes; empty recovery stays out of ordinary navigation. */
export function MissingSessionRecovery({ cwd, conversationId, ready, send, listing, result }: MissingSessionRecoveryProps) {
	const t = useT(), id = useId();
	const [expanded, setExpanded] = useState(false);
	const [hasSessions, setHasSessions] = useState(false);
	const [requestId, setRequestId] = useState("");
	const [selected, setSelected] = useState<MissingSessionSummary | null>(null);
	const [pending, setPending] = useState("");
	const [error, setError] = useState("");
	const dialog = useDialogFocus(!!selected);
	const current = listing?.reqId === requestId && listing.conversationId === conversationId && listing.cwd === cwd ? listing : null;
	useEffect(() => { setExpanded(false); setHasSessions(false); setSelected(null); setPending(""); setRequestId(""); setError(""); }, [cwd, conversationId]);
	useEffect(() => {
		if (!ready) { setPending(""); setRequestId(""); setSelected(null); }
	}, [ready]);
	useEffect(() => {
		if (!ready || !conversationId || !cwd) return;
		const reqId = randomUuid();
		if (send({ type: "list_missing_sessions", reqId, conversationId })) setRequestId(reqId);
	}, [ready, cwd, conversationId, send]);
	useEffect(() => {
		if (!current || current.error) return;
		setHasSessions(current.sessions.length > 0);
		if (!current.sessions.length) setExpanded(false);
	}, [current]);
	useEffect(() => {
		if (!pending || result?.reqId !== pending) return;
		setPending("");
		if (result.status === "error") setError(result.error ?? t("missingSessionFailed"));
		else { setSelected(null); setExpanded(false); refresh(); }
	}, [pending, result, t]);
	const refresh = () => {
		const reqId = randomUuid();
		setError("");
		if (send({ type: "list_missing_sessions", reqId, conversationId })) setRequestId(reqId);
		else setError(t("missingSessionFailed"));
	};
	const act = (action: "fork" | "continue" | "cancel") => {
		if (!selected || pending) return;
		const reqId = randomUuid();
		if (send({ type: "recover_missing_session", reqId, conversationId, token: selected.token, action })) {
			setError("");
			if (action === "cancel") { setSelected(null); setExpanded(false); refresh(); }
			else setPending(reqId);
		} else setError(t("missingSessionFailed"));
	};
	if (!hasSessions && !selected) return null;
	return <section className="missing-sessions">
		<button type="button" className="missing-sessions-toggle" disabled={!ready} aria-expanded={expanded} aria-controls={`${id}-list`} onClick={() => { setExpanded(value => !value); if (!expanded) refresh(); }}>
			{expanded ? <FiChevronDown aria-hidden="true" /> : <FiChevronRight aria-hidden="true" />}<span>{t("missingSessions")}</span>
		</button>
		{expanded && <div id={`${id}-list`} className="missing-sessions-list" aria-busy={!!requestId && !current}>
			{!current && requestId && <p role="status">{t("loading")}</p>}
			{(current?.error || error) && !selected && <p role="alert">{current?.error || error}</p>}
			{current?.sessions.map(session => <button className="missing-session-item" type="button" key={session.token} onClick={() => { setSelected(session); setError(""); }} title={session.cwd}>
				<span>{session.name || skillAwarePreview(session.firstMessage) || t("missingSessionUntitled")}</span><small>{session.cwd}</small>
			</button>)}
			<button type="button" className="missing-sessions-refresh" disabled={!ready || (!!requestId && !current)} onClick={refresh}>{t("missingSessionsRefresh")}</button>
		</div>}
		{selected && createPortal(<div className="wiki-modal-backdrop"><div ref={dialog} className="wiki-confirm missing-session-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} onKeyDown={event => { if (event.key === "Escape" && !pending) { event.stopPropagation(); act("cancel"); } }}>
			<h2 id={`${id}-title`}>{t("missingSessionTitle")}</h2>
			<p id={`${id}-hint`}>{t("missingSessionHint")}</p>
			<dl><dt>{t("missingSessionOriginal")}</dt><dd>{selected.cwd}</dd><dt>{t("missingSessionTarget")}</dt><dd>{cwd}</dd></dl>
			<p className="missing-session-continue-hint">{t("missingSessionContinueHint")}</p>
			{error && <p role="alert">{error}</p>}
			<div className="missing-session-actions">
				<button type="button" className="primary" disabled={!ready || !!pending} onClick={() => act("fork")}>{pending ? t("missingSessionOpening") : t("missingSessionFork")}</button>
				<button type="button" disabled={!ready || !!pending} onClick={() => act("continue")}>{t("missingSessionContinue")}</button>
				<button type="button" disabled={!!pending} onClick={() => act("cancel")}>{t("cancel")}</button>
			</div>
		</div></div>, document.body)}
	</section>;
}
