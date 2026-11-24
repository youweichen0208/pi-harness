import type { UiContentBlock, UiMessage, UiState, UiTraceRun, UiTraceSnapshot } from "../../server/protocol.js";
import { formatTraceMs, traceMetric, traceShare } from "./trace-presentation.js";

export function escapeTraceHtml(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function exportBlock(block: UiContentBlock): string {
	const text = "text" in block ? block.text : undefined;
	if (typeof text === "string") return text;
	if (block.type === "thinking") return `[Thinking]\n${block.thinking}`;
	if (block.type === "toolCall") return `[Tool call: ${block.name}]\n${block.argumentsText ?? ""}`;
	if (block.type === "bash") return `[Bash]\n$ ${block.command}\n${block.output}`;
	if (block.type === "image") return `[Image${block.mimeType ? `: ${block.mimeType}` : ""}]`;
	return `[${block.type}]`;
}

export function traceTranscript(messages: readonly UiMessage[]): string {
	return messages.map(message => {
		const meta = [message.role, message.provider, message.model, message.timestamp ? new Date(message.timestamp).toISOString() : undefined].filter(Boolean).join(" · ");
		const body = message.content.map(exportBlock).filter(Boolean).join("\n\n");
		return `${meta}\n${body}${message.errorMessage ? `\n[Error] ${message.errorMessage}` : ""}`;
	}).join("\n\n────────────────────────\n\n");
}

function exportTimeline(run: UiTraceRun): string {
	const intervals = [
		...run.requests.map(r => ({ label: r.model ?? r.provider ?? "Model", start: r.hookStartMs, end: r.messageEndMs, status: r.status })),
		...run.tools.map(tool => ({ label: tool.toolName, start: tool.startMs, end: tool.endMs, status: tool.status })),
	].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
	if (!intervals.length) return "";
	const origin = run.agentStartMs;
	const limit = intervals.reduce((latest, row) => Math.max(latest, row.end ?? row.start ?? origin), run.agentSettledMs ?? origin);
	const extent = limit - origin;
	const rows = intervals.map(({ label, start, end, status }) => {
		const measured = start !== undefined && end !== undefined && end >= start && status !== "ambiguous";
		let bar = "";
		if (measured && extent > 0 && start >= origin) {
			const left = 100 * (start - origin) / extent;
			const width = 100 * (end - start) / extent;
			bar = `<i style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%"></i>`;
		}
		return `<div class="lane"><span>${escapeTraceHtml(label)}</span><div class="track">${bar}</div><small>${formatTraceMs(measured ? end - start : null)}</small></div>`;
	}).join("");
	return `<h4>Timeline</h4><div class="lane"><span></span><div class="ticks"><small>0</small><small>${formatTraceMs(extent)}</small></div></div>${rows}`;
}

function exportRun(run: UiTraceRun): string {
	const cards = Object.entries({ agent_active_wall_ms: "Active time", model_wall_union_ms: "Model", tool_wall_union_ms: "Tools", host_wall_union_ms: "Host", unclassified_wall_ms: "Unclassified" }).map(([key, label]) => {
		const metric = traceMetric(run.aggregates[key]);
		return `<div class="metric"><span>${label}</span><strong>${escapeTraceHtml(metric.text)}</strong>${key !== "agent_active_wall_ms" ? `<small>${escapeTraceHtml(traceShare(run, key))}</small>` : ""}</div>`;
	}).join("");
	const requests = run.requests.map(request => `<tr><td>${escapeTraceHtml(request.provider ?? "")}/${escapeTraceHtml(request.model ?? "")}</td><td>${escapeTraceHtml(request.status)}</td><td>${escapeTraceHtml(traceMetric(request.metrics.provider_hook_to_message_end_ms).text)}</td></tr>`).join("");
	const tools = run.tools.map(tool => `<tr><td>${escapeTraceHtml(tool.toolName)}</td><td>${escapeTraceHtml(tool.status)}</td><td>${escapeTraceHtml(formatTraceMs(tool.durationMs ?? (tool.endMs !== undefined ? tool.endMs - tool.startMs : null)))}</td></tr>`).join("");
	return `<section class="run"><h3>${escapeTraceHtml(run.startedAt ?? run.runId)} · ${escapeTraceHtml(run.status)}</h3><div class="metrics">${cards}</div>${exportTimeline(run)}<h4>Model requests</h4>${requests ? `<table><thead><tr><th>Model</th><th>Status</th><th>Duration</th></tr></thead><tbody>${requests}</tbody></table>` : "<p>None</p>"}<h4>Tools</h4>${tools ? `<table><thead><tr><th>Tool</th><th>Status</th><th>Duration</th></tr></thead><tbody>${tools}</tbody></table>` : "<p>None</p>"}</section>`;
}

export function renderTraceExportHtml(state: UiState | null, trace: UiTraceSnapshot, exportedAt = new Date().toISOString()): string {
	const transcript = traceTranscript(state?.messages ?? []);
	const runs = trace.runs.map(exportRun).join("");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>pi-harness session ${escapeTraceHtml(trace.sessionId)}</title><style>
:root{color-scheme:light dark;--line:color-mix(in srgb,CanvasText 18%,Canvas);--panel:color-mix(in srgb,CanvasText 3%,Canvas)}*{box-sizing:border-box}body{color:CanvasText;background:Canvas;max-width:1100px;margin:0 auto;padding:32px;font:14px/1.6 system-ui,sans-serif}h1,h2,h3,h4{line-height:1.3}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;border:1px solid var(--line);border-radius:8px}section{margin-top:28px}.notice{padding:12px;border:1px solid var(--line);border-radius:8px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.metric{background:var(--panel);padding:14px;border:1px solid var(--line);border-radius:8px}.metric span,.metric strong,.metric small{display:block;overflow-wrap:anywhere} .metric strong{font:600 20px/1.6 ui-monospace,monospace}.metric small{font-variant-numeric:tabular-nums}.run{padding:16px;border:1px solid var(--line);border-radius:10px}h3{margin-top:0}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;overflow-wrap:anywhere}details{margin-top:24px}.lane{display:grid;grid-template-columns:minmax(0,30%) 1fr 64px;align-items:center;gap:8px;margin-block:5px;overflow-wrap:anywhere}.track{position:relative;height:10px;background:var(--panel);border-radius:4px;overflow:hidden}.track i{position:absolute;inset-block:0;min-width:1px;background:LinkText;border-radius:4px}.ticks{display:flex;justify-content:space-between}summary{cursor:pointer;font-weight:600}code{font-family:monospace}@media(max-width:600px){body{padding:12px}.run{padding:10px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><h1>pi-harness session export</h1><p>Exported ${escapeTraceHtml(exportedAt)} · Session <code>${escapeTraceHtml(trace.sessionId)}</code>${state?.conversationId ? ` · Conversation <code>${escapeTraceHtml(state.conversationId)}</code>` : ""}</p><p class="notice">The transcript section contains message and tool content. Trace metadata contains identifiers and timing and is not anonymous.</p><section><h2>Execution trace</h2>${runs || "<p>No recorded runs.</p>"}</section><details><summary>Transcript</summary><pre>${escapeTraceHtml(transcript || "No transcript messages.")}</pre></details><details><summary>Raw trace metadata</summary><pre>${escapeTraceHtml(JSON.stringify(trace, null, 2))}</pre></details></body></html>`;
}

export function traceExportFileName(trace: UiTraceSnapshot, format: "html" | "json"): string {
	const id = trace.sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "session";
	return `pi-harness-${id}-${format === "html" ? "session.html" : "trace.json"}`;
}
