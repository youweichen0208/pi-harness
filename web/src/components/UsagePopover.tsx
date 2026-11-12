import { useEffect, useRef, useState } from "react";
import type { ClientMessage, UiState } from "../types";
import { useT } from "../i18n";
import { cacheHitPercent } from "../usage-metrics";

type Stats = UiState["stats"];

const formatTokens = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export function UsagePopover({ stats, conversationId, send, onRefresh }: { stats?: Stats; conversationId?: string; send?: (message: Extract<ClientMessage, { type: "get_cache_warming" }>) => boolean; onRefresh?: () => void }) {
	const t = useT();
	const root = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const pinned = useRef(false);
	useEffect(() => { setOpen(false); pinned.current = false; }, [conversationId]);
	useEffect(() => {
		if (!open || !conversationId || (!send && !onRefresh)) return;
		const refresh = () => { if (document.visibilityState === "visible") { if (onRefresh) onRefresh(); else send?.({ type: "get_cache_warming", conversationId }); } };
		refresh();
		const timer = window.setInterval(refresh, 5000);
		return () => window.clearInterval(timer);
	}, [open, conversationId, send, onRefresh]);
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); pinned.current = false; } };
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); pinned.current = false; } };
		document.addEventListener("pointerdown", outside, true);
		document.addEventListener("keydown", escape);
		return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
	}, [open]);
	const context = stats?.contextUsage;
	const percent = context?.percent === null || context?.percent === undefined ? null : Math.round(context.percent);
	const shownPercent = percent === null ? 0 : Math.max(0, Math.min(100, percent));
	const sessionRate = stats ? cacheHitPercent(stats.tokens) : null;
	const warming = stats?.cacheWarming;
	const hasSummary = (percent !== null && percent > 0) || (sessionRate !== null && sessionRate > 0);
	const money = (cost: number) => `$${cost.toFixed(4)}`;
	if (!hasSummary && !warming) return null;
	return <div className="usage-control" ref={root} onPointerEnter={() => setOpen(true)} onPointerLeave={() => { if (!pinned.current) setOpen(false); }}>
		<button type="button" className={`usage-trigger${percent !== null && percent >= 80 ? " warn" : ""}`} title={`${t("usageContextTitle")} · ${t("usageCacheTitle")}`} aria-label={`${t("usageContextTitle")} ${percent ?? "—"}%`} aria-expanded={open} onPointerDown={() => { pinned.current = !pinned.current; setOpen(pinned.current); }} onClick={(event) => { if (event.detail === 0) { pinned.current = !pinned.current; setOpen(pinned.current); } }}>
			{percent !== null && percent > 0 && <><span className="usage-context-label">{t("context")}</span><span className="usage-meter" aria-hidden="true"><i className={percent >= 80 ? "warn" : ""} style={{ width: `${shownPercent}%` }} /></span><span className="usage-percent">{percent}%</span></>}
			{sessionRate !== null && sessionRate > 0 && <span className="usage-cache-short">{percent !== null && percent > 0 ? "· " : ""}{t("usageCacheShort")} <strong className={sessionRate < 50 ? "warn" : ""}>{sessionRate}%</strong></span>}
			{!hasSummary && <span>{t("usageDetails")}</span>}
		</button>
		{open && <div className="usage-popover" role="dialog" aria-label={t("usageContextTitle")}>
			<div className="usage-head"><strong>{t("usageContextTitle")}</strong><span>{context?.tokens === null || context?.tokens === undefined ? "—" : formatTokens(context.tokens)} / {context?.contextWindow ? formatTokens(context.contextWindow) : "—"}</span></div>
			<div className="usage-progress" role="img" aria-label={`${t("usageContextTitle")} ${percent ?? "—"}%`}><span className={percent !== null && percent >= 80 ? "warn" : ""} style={{ width: `${shownPercent}%` }} /></div>
			<div className="usage-head usage-cache-section"><strong>{t("usageCacheTitle")}</strong><span className={sessionRate !== null && sessionRate < 50 ? "warn" : ""}>{sessionRate === null ? "—" : `${sessionRate}%`}</span></div>
			<div className="usage-head usage-cache-section"><strong>{t("usageSessionCost")}</strong><span>{money(stats?.cost ?? 0)}</span></div>
			{warming && <section className="usage-warming" aria-label={t("cacheWarmingGlobal")}>
				<div className="usage-head"><strong>{t("cacheWarmingLabel")}</strong><span>{t(warming.state === "refreshing" ? "cacheWarmingRefreshing" : warming.state === "scheduled" ? "cacheWarmingScheduled" : "cacheWarmingInactive")}</span></div>
				<div className="usage-head"><span>{t("cacheWarmingGlobal")}</span><span>{t(warming.mode === "off" ? "cacheWarmingOff" : warming.mode === "idle" ? "cacheWarmingIdle" : "cacheWarmingStreaming")}</span></div>
				{warming.nextWarmAt !== undefined && <div className="usage-head"><span>{t("cacheWarmingNext")}</span><time dateTime={new Date(warming.nextWarmAt).toISOString()}>{new Date(warming.nextWarmAt).toLocaleTimeString()}</time></div>}
				{warming.reason && <p className="usage-warming-reason">{warming.reason}</p>}
				<div className="usage-head"><span>{t("cacheWarmingCost")}</span><span>{money(warming.cost)}</span></div>
				<p className="usage-warming-reason">{t("cacheWarmingCostHint")}</p>
			</section>}
		</div>}
	</div>;
}
