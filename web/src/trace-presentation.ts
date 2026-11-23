import type { UiTraceMetric, UiTraceRun } from "../../server/protocol.js";

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

export function traceShare(run: UiTraceRun, key: string) {
	const total = run.aggregates.agent_active_wall_ms;
	const part = run.aggregates[key];
	if (total?.status !== "measured" || !total.value || part?.status !== "measured" || part.value == null) return "";
	return ((100 * part.value) / total.value).toFixed(1) + "%";
}

/** Input spans are sorted by start and belong to one host category. */
export function mergeHostIntervals(group: readonly { start: number; end: number }[], lo: number, hi: number) {
	const merged: { start: number; end: number }[] = [];
	for (const span of group) {
		const start = Math.max(lo, span.start);
		const end = Math.min(hi, span.end);
		if (end < start) continue;
		const last = merged.at(-1);
		if (last && start <= last.end) last.end = Math.max(last.end, end);
		else merged.push({ start, end });
	}
	return merged;
}
