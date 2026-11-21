import type { UiTraceMetric, UiTraceRun } from "../../server/protocol.js";

export interface TraceTimelineItem {
	id: string;
	kind: "model" | "tool" | "host";
	label: string;
	status: string;
	startMs: number;
	endMs: number;
	left: number;
	width: number;
}

export function formatTraceMs(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	if (Math.abs(value) < 1) return `${(value * 1000).toFixed(0)}µs`;
	if (Math.abs(value) < 1000) return `${value.toFixed(Math.abs(value) < 10 ? 2 : 1)}ms`;
	return `${(value / 1000).toFixed(2)}s`;
}

export function traceMetric(metric: UiTraceMetric | undefined): { text: string; status: string } {
	if (!metric) return { text: "—", status: "unmeasured" };
	return { text: metric.status === "measured" ? formatTraceMs(metric.value) : metric.status, status: metric.status };
}

export function traceRunsFilter(runs: UiTraceRun[], query: string): UiTraceRun[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return runs;
	return runs.filter(run => [run.status, run.runId, ...run.requests.flatMap(request => [request.provider, request.api, request.model, request.status]), ...run.tools.flatMap(tool => [tool.toolName, tool.status])].some(value => value?.toLowerCase().includes(normalized)));
}

export function traceTimeline(run: UiTraceRun): TraceTimelineItem[] {
	const items: Omit<TraceTimelineItem, "left" | "width">[] = [];
	for (const request of run.requests) if (request.hookStartMs !== undefined && request.messageEndMs !== undefined) items.push({
		id: request.requestId, kind: "model", label: request.model ?? request.provider ?? "model", status: request.status,
		startMs: request.hookStartMs, endMs: request.messageEndMs,
	});
	for (const tool of run.tools) if (tool.endMs !== undefined) items.push({
		id: tool.toolCallId, kind: "tool", label: tool.toolName, status: tool.status, startMs: tool.startMs, endMs: tool.endMs,
	});
	const host = [...run.hostSpans].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	let active: { startMs: number; endMs: number } | undefined;
	let hostIndex = 0;
	for (const span of host) {
		if (active && span.startMs <= active.endMs) {
			active.endMs = Math.max(active.endMs, span.endMs);
			continue;
		}
		if (active) items.push({ id: `host-${hostIndex++}`, kind: "host", label: "host", status: "observed", startMs: active.startMs, endMs: active.endMs });
		active = { startMs: span.startMs, endMs: span.endMs };
	}
	if (active) items.push({ id: `host-${hostIndex}`, kind: "host", label: "host", status: "observed", startMs: active.startMs, endMs: active.endMs });
	const start = run.agentStartMs;
	const fallbackEnd = Math.max(start + 1, ...items.map(item => item.endMs));
	const end = run.agentSettledMs ?? fallbackEnd;
	const duration = Math.max(1, end - start);
	return items.map(item => {
		const left = Math.max(0, Math.min(100, (item.startMs - start) / duration * 100));
		return { ...item, left, width: Math.max(0.35, Math.min(100 - left, (item.endMs - item.startMs) / duration * 100)) };
	});
}
