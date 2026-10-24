import { copyText } from "../clipboard";
import { isProcessNarration } from "../command-reading";
import { useState } from "react";
import { FiCopy, FiRefreshCw } from "react-icons/fi";
import { useT } from "../i18n";
import type { UiMessage } from "../types";

export function ReplyActions({ message, last, regenerate }: { message: UiMessage; last: boolean; regenerate?: () => void }) {
	const t = useT(), [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const text = message.content.map(block => block.type === "text" ? block.text : "").join("\n");
	if (!text.trim() || message.content.some(block => block.type === "toolCall") || (!last && isProcessNarration(text))) return null;
	return <div className={`reply-actions ${last ? "last" : ""}`}>
		<button onClick={event => { setCopyError(false); void copyText(text, event.currentTarget.ownerDocument).then(() => setCopied(true)).catch(() => { setCopied(false); setCopyError(true); }); }}><FiCopy />{t(copyError ? "copyFailed" : copied ? "copied" : "copy")}</button>
		{regenerate && <button onClick={regenerate}><FiRefreshCw />{t("changesRegenerate")}</button>}
		{message.timestamp && <time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
	</div>;
}
