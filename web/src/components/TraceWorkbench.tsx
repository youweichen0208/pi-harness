import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiActivity, FiDownload, FiRefreshCw, FiSearch, FiX } from "react-icons/fi";
import type { ClientMessage, TraceResult, UiState, UiTraceRun } from "../types";
import { useT } from "../i18n";
import { useDialogFocus } from "../use-dialog-focus";
import { randomUuid } from "../uuid";
import { formatTraceMs, traceMetric, traceRunsFilter, traceTimeline } from "../trace-presentation";
import { renderTraceExportHtml, traceExportFileName } from "../trace-export";

function downloadTrace(format: "html" | "json", trace: NonNullable<TraceResult["trace"]>, state: UiState | null) {
	const content = format === "html" ? renderTraceExportHtml(state, trace) : JSON.stringify(trace, null, 2);
	const url = URL.createObjectURL(new Blob([content], { type: format === "html" ? "text/html;charset=utf-8" : "application/json;charset=utf-8" }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = traceExportFileName(trace, format);
	anchor.style.display = "none";
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TraceWorkbench({ state, connected, send }: { state: UiState | null; connected: boolean; send: (message: ClientMessage) => boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [trace, setTrace] = useState<TraceResult["trace"]>();
	const [selectedRunId, setSelectedRunId] = useState<string>();
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const pending = useRef(new Set<string>());
	const stateRef = useRef(state); stateRef.current = state;
	const dialogRef = useDialogFocus<HTMLElement>(open);

	const requestTrace = useCallback(() => {
		const current = stateRef.current;
		if (!current?.conversationId || !connected) return;
		const reqId = randomUuid();
		pending.current.add(reqId);
		setLoading(true);
		if (!send({ type: "trace_get", reqId, conversationId: current.conversationId })) {
			pending.current.delete(reqId);
			setLoading(false);
			setError(t("traceDisconnected"));
		}
	}, [connected, send, t]);

	useEffect(() => {
		const receive = (event: Event) => {
			const message = (event as CustomEvent<TraceResult>).detail;
			if (message.conversationId !== stateRef.current?.conversationId) return;
			if (!message.open && !pending.current.has(message.reqId)) return;
			pending.current.delete(message.reqId);
			setLoading(false);
			if (message.open) setOpen(true);
			if (message.error) setError(message.error);
			if (message.trace) {
				if (message.export) downloadTrace(message.export, message.trace, stateRef.current);
				setTrace(message.trace);
				setError("");
				setSelectedRunId(previous => message.trace!.runs.some(run => run.runId === previous) ? previous : message.trace!.runs.at(-1)?.runId);
			}
		};
		const opener = () => setOpen(true);
		window.addEventListener("pi-trace-response", receive);
		window.addEventListener("pi-trace-open", opener);
		return () => { window.removeEventListener("pi-trace-response", receive); window.removeEventListener("pi-trace-open", opener); };
	}, []);

	useEffect(() => {
		setTrace(undefined); setSelectedRunId(undefined); setError(""); pending.current.clear();
		if (open) requestTrace();
	}, [state?.conversationId]);
	useEffect(() => { if (open) requestTrace(); }, [open]);
	useEffect(() => {
		if (!open || !state?.isStreaming) return;
		const timer = window.setInterval(requestTrace, 2000);
		return () => window.clearInterval(timer);
	}, [open, state?.isStreaming, requestTrace]);

	const runs = useMemo(() => traceRunsFilter(trace?.runs ?? [], query), [trace, query]);
	const selected = runs.find(run => run.runId === selectedRunId) ?? runs.at(-1);
	const timeline = useMemo(() => selected ? traceTimeline(selected) : [], [selected]);
	if (!open) return null;
	const aggregates = selected?.aggregates ?? {};
	const cards: [string, string][] = [
		["agent_active_wall_ms", t("traceActive")],
		["model_wall_union_ms", t("traceModel")],
		["tool_wall_union_ms", t("traceTools")],
		["host_wall_union_ms", t("traceHost")],
		["unclassified_wall_ms", t("traceUnclassified")],
	];
	return <div className="trace-modal-backdrop">
		<section className="trace-workbench" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("traceTitle")} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
			<header className="trace-header"><div><FiActivity /><strong>{t("traceTitle")}</strong><span>{state?.conversationId}</span></div><div><button className="icon-button" aria-label={t("traceExportHtml")} title={t("traceExportHtml")} disabled={!trace} onClick={() => trace && downloadTrace("html", trace, state)}><FiDownload /><span>HTML</span></button><button className="icon-button" aria-label={t("traceExportJson")} title={t("traceExportJson")} disabled={!trace} onClick={() => trace && downloadTrace("json", trace, state)}><FiDownload /><span>JSON</span></button><button className="icon-button" aria-label={t("refresh")} title={t("refresh")} disabled={!connected || loading} onClick={requestTrace}><FiRefreshCw /></button><button className="icon-button" aria-label={t("close")} title={t("close")} onClick={() => setOpen(false)}><FiX /></button></div></header>
			{trace?.persistence.state === "degraded" && <div className="trace-warning" role="status">{t("tracePersistenceDegraded")}: {trace.persistence.error}</div>}
			{trace && <div className="trace-privacy">{t("traceMetadataNotice")}</div>}
			<div className="trace-toolbar"><label><FiSearch /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("traceSearch")} aria-label={t("traceSearch")} /></label><span>{runs.length} / {trace?.runs.length ?? 0} {t("traceRuns")}</span></div>
			{error && <div className="trace-error" role="alert">{error}</div>}
			{!error && !trace?.runs.length && <div className="trace-empty">{loading ? t("loading") : t("traceNoRuns")}</div>}
			{selected && <div className="trace-body">
				<aside className="trace-run-list" aria-label={t("traceRuns")}>{runs.map(run => <button key={run.runId} className={run.runId === selected.runId ? "selected" : ""} onClick={() => setSelectedRunId(run.runId)}><span><strong>{run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : run.runId.slice(0, 8)}</strong><small>{run.requests.length} {t("traceRequests")} · {run.tools.length} {t("traceTools")}</small></span><em className={`trace-status status-${run.status}`}>{run.status}</em></button>)}</aside>
				<main className="trace-detail">
					<div className="trace-aggregate-grid">{cards.map(([key, label]) => { const metric = traceMetric(aggregates[key]); return <div key={key}><small>{label}</small><strong className={`metric-${metric.status}`}>{metric.text}</strong>{aggregates[key]?.reason && <span>{aggregates[key].reason}</span>}</div>; })}</div>
					{aggregates.host_observed_lower_bound_ms && aggregates.host_wall_union_ms?.status !== "measured" && <div className="trace-warning">{t("traceObservedLowerBound")}: {formatTraceMs(aggregates.host_observed_lower_bound_ms.value)}</div>}
					<section className="trace-timeline-section"><h3>{t("traceTimeline")}</h3><div className="trace-timeline">{(["model", "tool", "host"] as const).map(kind => <div className="trace-lane" key={kind}><span>{kind === "model" ? t("traceModel") : kind === "tool" ? t("traceTools") : t("traceHost")}</span><div className="trace-lane-track">{timeline.filter(item => item.kind === kind).map(item => <span key={item.id} role="img" className={`trace-span trace-span-${kind} status-${item.status}`} style={{ left: `${item.left}%`, width: `${item.width}%` }} title={`${item.label} · ${formatTraceMs(item.endMs - item.startMs)} · ${item.status}`} aria-label={`${item.label} ${formatTraceMs(item.endMs - item.startMs)}`} />)}</div></div>)}</div></section>
					<TraceRequests run={selected} />
					<section><h3>{t("traceTools")}</h3>{selected.tools.length ? <div className="trace-table">{selected.tools.map(tool => <div className="trace-table-row" key={tool.toolCallId}><strong>{tool.toolName}</strong><span>{formatTraceMs(tool.durationMs ?? (tool.endMs !== undefined ? tool.endMs - tool.startMs : null))}</span><span>{t("traceAssistantGap")}: {formatTraceMs(tool.assistantToToolGapMs)}</span><em className={`trace-status status-${tool.status}`}>{tool.status}</em></div>)}</div> : <p className="trace-muted">{t("traceNoTools")}</p>}</section>
				</main>
			</div>}
		</section>
	</div>;
}

function TraceRequests({ run }: { run: UiTraceRun }) {
	const t = useT();
	return <section><h3>{t("traceRequests")}</h3>{run.requests.length ? <div className="trace-table">{run.requests.map(request => <div className="trace-request" key={request.requestId}><div><strong>{request.provider ?? "provider"}/{request.model ?? "model"}</strong><span>turn {request.turnIndex ?? "—"}</span><em className={`trace-status status-${request.status}`}>{request.status}</em></div><div><span>{t("traceProviderDuration")}: {traceMetric(request.metrics.provider_hook_to_message_end_ms).text}</span><span>{t("traceProviderHeaders")}: {traceMetric(request.metrics.provider_hook_to_headers_ms).text}</span><span>{t("traceFirstVisible")}: {traceMetric(request.metrics.first_event_to_first_visible_delta_ms).text}</span><span>{t("traceToolGap")}: {formatTraceMs(request.toolToProviderGapMs)}</span></div></div>)}</div> : <p className="trace-muted">{t("traceNoRequests")}</p>}</section>;
}
