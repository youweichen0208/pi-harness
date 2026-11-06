import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientMessage, TreeResponse } from "../types";
import type { CodemodeGroup } from "../codemode-records";
import { useT } from "../i18n";
import { randomUuid } from "../uuid";
import { useDialogFocus } from "../use-dialog-focus";
import { CodemodeCard } from "./CodemodeCard";

type Content = Extract<TreeResponse, { type: "tree_content_result" }>["codemode"];
export function CodemodeHistoryDialog({ group, conversationId, send, onClose }: { group: CodemodeGroup; conversationId: string; send: (message: ClientMessage) => boolean; onClose: () => void }) {
	const t = useT();
	const ref = useDialogFocus<HTMLElement>();
	const [content, setContent] = useState<Content>();
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const reqId = randomUuid();
		setContent(undefined); setError("");
		const receive = (event: Event) => {
			const message = (event as CustomEvent<TreeResponse>).detail;
			if (!("reqId" in message) || message.reqId !== reqId || message.conversationId !== conversationId) return;
			clearTimeout(timer);
			if (message.type === "tree_content_result" && message.codemode) setContent(message.codemode);
			else setError(message.type === "tree_navigate_result" ? message.error ?? t("treeFailed") : t("treeFailed"));
		};
		const timer = window.setTimeout(() => setError(t("treeFailed")), 15000);
		window.addEventListener("pi-tree-response", receive);
		if (!group.entryId || !send({ type: "tree_content", conversationId, reqId, entryId: group.entryId, codemodeToolCallId: group.id })) { clearTimeout(timer); setError(t("treeDisconnected")); }
		return () => { clearTimeout(timer); window.removeEventListener("pi-tree-response", receive); };
	}, [group.entryId, group.id, conversationId, send, attempt, t]);
	return createPortal(<div className="tree-modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
		<section className="tree-dialog cm-history-dialog" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("cmHistoryTitle")} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
			<h3>{t("cmHistoryTitle")}</h3>
			{content ? <CodemodeCard readOnly block={content.block} view={{ result: content.result, streaming: false, runActive: false }}/> : error ? <p role="alert">{error}</p> : <p role="status">{t("loading")}</p>}
			{error && <button onClick={() => setAttempt(value => value + 1)}>{t("retry")}</button>}
			<button onClick={onClose}>{t("close")}</button>
		</section>
	</div>, document.body);
}
