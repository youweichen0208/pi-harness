import { useContext, useEffect, useRef, useState } from "react";
import { useChatT } from "../i18n";
import { ToolImageContext } from "../tool-image-context";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";

export function ToolResultImage({ url, index, alt }: { url: string; index: number; alt: string }) {
	const t = useChatT(), owner = useContext(ToolImageContext);
	const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState("");
	const current = useRef(owner), pending = useRef(false);
	current.current = owner;
	const alive = useRef(true);
	useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
	const mime = /^data:(image\/(?:png|jpeg|gif|webp));base64,/.exec(url)?.[1];
	const filename = `generated-${index}.${mime === "image/jpeg" ? "jpg" : mime?.split("/")[1] ?? "png"}`;
	const action = async (attach: boolean) => {
		if (!owner?.active || !mime || pending.current) return;
		const target = owner;
		pending.current = true; setBusy(true); setFeedback("");
		try {
			if (attach) {
				const blob = await (await fetch(url)).blob();
				if (!alive.current || !current.current?.active || current.current.conversationId !== target.conversationId || current.current.cwd !== target.cwd) return;
				if (!await target.attach?.(new File([blob], filename, { type: mime }), target.conversationId)) throw Error(t("imageLoadFailed", { name: filename }));
				if (alive.current) setFeedback(t("cmAttached"));
			} else {
				const response = await fetch(withToken("/api/tool-image"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: getClientId(), cwd: target.cwd, conversationId: target.conversationId, dataUrl: url }) });
				const result = await response.json();
				if (!response.ok) throw Error(result.error ?? `HTTP ${response.status}`);
				if (alive.current) setFeedback(t("cmSaved", { path: result.path }));
			}
		} catch (error) { if (alive.current) setFeedback((error as Error).message); }
		finally { pending.current = false; if (alive.current) setBusy(false); }
	};
	return <div className="tool-image-preview">
		<a href={url} target="_blank" rel="noreferrer" className="tool-result-image" aria-label={t("zoomCode")}><img src={url} alt={alt} loading="lazy" /></a>
		<div className="tool-image-actions">
			<a href={url} download={filename}>{t("downloadImage")}</a>
			{owner && mime && <>
				<button type="button" disabled={busy || !owner.active} onClick={() => void action(false)}>{t("cmSaveImage")}</button>
				{owner.attach && <button type="button" disabled={busy || !owner.active} onClick={() => void action(true)}>{t("cmAttachImage")}</button>}
			</>}
		</div>
		{feedback && <p className="tool-image-feedback" role="status">{feedback}</p>}
	</div>;
}
