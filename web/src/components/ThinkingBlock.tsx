import { useEffect, useRef, useState } from "react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import { useT } from "../i18n";

interface ThinkingBlockProps {
	thinking: string;
	durationMs?: number;
	/** True while the assistant is still streaming this thinking block. */
	streaming?: boolean;
	/** 设置面板「完整显示思考」开关：true（开）→ 思考始终完整展开并自动换行
	 *  （流式推理过程也实时可见）；false（关）→ 折叠成一行摘要，流式中一行
	 *  实时显示最新文本。 */
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

export function ThinkingBlock({ thinking, durationMs, streaming, wrap = true }: ThinkingBlockProps) {
	const t = useT();
	// null = 未手动点过 → 跟随开关：wrap=true（开）→ 完整展开；wrap=false（关）→ 折叠。
	// 流式与结束后行为一致——不再出现「流式折叠、结束后又自动展开」的跳动。
	const [open, setOpen] = useState<boolean | null>(null);
	const expanded = open ?? wrap;
	const seconds = useLiveSeconds(!!streaming);

	if (streaming) {
		if (!thinking.trim()) return null;
		// 3a: one row — spinner, "思考中 N 秒" and the latest line, ellipsized.
		return <div className={`thinking live${expanded ? " open" : ""}`}>
			<button type="button" className="thinking-toggle" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
				<span className="thinking-spinner" aria-hidden="true" />
				<span className="thinking-label">{t("thinkingLive", { n: seconds })}</span>
				{!expanded && <span className="thinking-live-label">{thinking.trim().split("\n").at(-1)}</span>}
			</button>
			{expanded && <div className="thinking-body">{thinking}</div>}
		</div>;
	}
	return <div className={`thinking ${expanded ? "open" : ""}`}>
		<button type="button" className="thinking-toggle" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
			{expanded ? <FiChevronDown /> : <FiChevronRight />}
			<span className="thinking-label" title={durationMs === undefined ? t("thinkingUnrecorded") : undefined}>{durationMs !== undefined ? t("thinkingFor", { n: Math.max(1, Math.round(durationMs / 1000)) }) : t("thinkingDone")}</span>
		</button>
		{expanded && <div className="thinking-body">{thinking}</div>}
	</div>;
}
