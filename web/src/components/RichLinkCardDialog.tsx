import { useEffect, useRef, useState } from "react";
import { WikiReadingDialog } from "./WikiReading";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import type { LinkPreview } from "../types";
export function RichLinkCardDialog({ onClose, onInsert }: { onClose: () => void; onInsert: (card: LinkPreview, signal: AbortSignal) => Promise<void> }) {
	const t = useT(); const [card, setCard] = useState<LinkPreview>({ url: "", title: "", description: "" });
	const [busy, setBusy] = useState(false), [error, setError] = useState(false);
	const request = useRef<AbortController | null>(null);
	useEffect(() => () => request.current?.abort(), []);
	const load = async () => {
		const controller = new AbortController(); request.current?.abort(); request.current = controller; setBusy(true); setError(false);
		try { const response = await fetch(withToken("/api/link-preview"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: card.url }), signal: controller.signal }); if (!response.ok) throw Error(); const result: LinkPreview = await response.json(); if (!controller.signal.aborted) setCard(result); }
		catch { if (!controller.signal.aborted) setError(true); }
		finally { if (!controller.signal.aborted) setBusy(false); }
	};
	return <WikiReadingDialog title={t("richLinkCard")} onClose={onClose}><form className="rich-card-form" onSubmit={async e => { e.preventDefault(); const controller = new AbortController(); request.current?.abort(); request.current = controller; setBusy(true); setError(false); try { await onInsert(card, controller.signal); if (!controller.signal.aborted) onClose(); } catch { if (!controller.signal.aborted) { setError(true); setBusy(false); } } }}>
		<label>{t("wikiLinkAddress")}<input type="url" required value={card.url} disabled={busy} onChange={e => setCard({ ...card, url: e.target.value, imageData: undefined })} /></label>
		<button type="button" disabled={busy || !/^https?:\/\//i.test(card.url)} onClick={() => void load()}>{t(busy ? "richCardLoading" : "richCardFetch")}</button>
		<label>{t("richCardTitle")}<input required maxLength={500} value={card.title} disabled={busy} onChange={e => setCard({ ...card, title: e.target.value })} /></label>
		<label>{t("richCardDescription")}<textarea maxLength={2000} value={card.description} disabled={busy} onChange={e => setCard({ ...card, description: e.target.value })} /></label>
		{card.imageData && <label><input type="checkbox" checked onChange={() => setCard({ ...card, imageData: undefined })} />{t("richCardCover")}</label>}
		{error && <p role="alert">{t("richCardFailed")}</p>}<button disabled={busy || !/^https?:\/\//i.test(card.url)}>{t("wikiInsertLinkAction")}</button>
	</form></WikiReadingDialog>;
}
