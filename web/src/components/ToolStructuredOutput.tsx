import { useMemo, useState } from "react";
import { FiCopy, FiDownload } from "react-icons/fi";
import { copyText } from "../clipboard";
import { highlightLine } from "../hljs-lite";
import { useT } from "../i18n";
import { ToolOutputDownload } from "./ToolOutputDownload";

export function ToolStructuredOutput({ output, url, truncated, error }: { output: string; url?: string; truncated: boolean; error: boolean }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
	const formatted = useMemo(() => {
		try {
			const parsed = JSON.parse(output);
			// Preserve long integer tokens verbatim instead of rounding them through Number.
			return { text: /\b\d{16,}\b/.test(output) ? output : JSON.stringify(parsed, null, 2), json: true };
		} catch { return { text: output, json: false }; }
	}, [output]);
	const lines = formatted.text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
	const visible = (expanded ? lines : lines.slice(0, 12)).join("\n");
	const copy = async (doc: Document) => {
		try { await copyText(output, doc); setCopyState("copied"); } catch { setCopyState("failed"); }
	};
	const download = () => {
		const objectUrl = URL.createObjectURL(new Blob([output], { type: "text/plain;charset=utf-8" }));
		const link = document.createElement("a"); link.href = objectUrl; link.download = formatted.json ? "tool-output.json" : "tool-output.txt"; link.click();
		setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
	};
	return <section className="structured-tool-output">
		<div className="toolcall-section-label">{t(error ? "errorOutput" : "output")}</div>
		<div className="structured-tool-code"><pre><code dangerouslySetInnerHTML={{ __html: highlightLine(visible, formatted.json ? "json" : null) }} /></pre>
			{lines.length > 12 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t("collapseCode") : t("expandAllLines", { n: lines.length })}</button>}
		</div>
		<footer><button type="button" onClick={event => void copy(event.currentTarget.ownerDocument)}><FiCopy />{t(copyState === "failed" ? "copyFailed" : copyState === "copied" ? "copied" : "bashCopyOutput")}</button>
			{url ? <ToolOutputDownload url={url} compact /> : !truncated && <button type="button" onClick={download}><FiDownload />{t("toolOutputDownload")}</button>}
			<span>{formatted.json ? "JSON" : "Text"} · {t("toolLineCount", { n: lines.length })}{truncated ? ` · ${t("subagentTruncated")}` : ""}</span>
		</footer>
	</section>;
}
