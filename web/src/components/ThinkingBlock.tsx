import { useEffect, useRef, useState } from "react";
import { FiChevronRight } from "react-icons/fi";
import { useChatT } from "../i18n";
import { readableThinkingSummary } from "../thinking-summary";

interface ThinkingBlockProps {
	thinking: string;
	/** True while the assistant is still streaming this thinking block. */
	streaming?: boolean;
	/** 设置面板「完整显示思考」开关：展开可读思考，或只显示计时与一行摘要。 */
	wrap?: boolean;
}

/** Seconds since this live block mounted; the SDK only reports a duration once thinking ends. */
function useLiveSeconds(active: boolean) {
	const started = useRef(Date.now());
	const [seconds, setSeconds] = useState(0);
	useEffect(() => {
		if (!active) return;
		const update = () => setSeconds(Math.floor((Date.now() - started.current) / 1000));
		update();
		const timer = window.setInterval(update, 1000);
		return () => window.clearInterval(timer);
	}, [active]);
	return seconds;
}

export function ThinkingBlock({ thinking, streaming, wrap = true }: ThinkingBlockProps) {
	const t = useChatT();
	const [open, setOpen] = useState<boolean | null>(null);
	const expanded = open ?? wrap;
	const seconds = useLiveSeconds(!!streaming);
	const summary = readableThinkingSummary(thinking);

	if (!streaming || !thinking.trim()) return null;
	const label = seconds < 60 ? t("thinkingLiveSeconds", { n: seconds }) : seconds < 3600 ? t("thinkingLiveMinutes", { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, "0") }) : t("thinkingLiveHours", { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });
	const status = <span className="thinking-status">
		<span className="thinking-label streaming-color">{label}</span>
		{summary && <FiChevronRight className="thinking-chevron" aria-hidden="true" />}
	</span>;
	return <div className={`thinking live${expanded && summary ? " open" : ""}`}>
		{summary ? <button type="button" className="thinking-toggle" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
			{status}
			{!expanded && <span className="thinking-summary">{summary}</span>}
		</button> : status}
		{summary && expanded && <div className="thinking-body">{thinking}</div>}
	</div>;
}
