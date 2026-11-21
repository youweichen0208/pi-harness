import type { UiContentBlock, UiMessage, UiState, UiTraceRun, UiTraceSnapshot } from "../../server/protocol.js";
import { formatTraceMs, traceMetric } from "./trace-presentation.js";

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

function exportRun(run: UiTraceRun): string {
	const cards = ["agent_active_wall_ms", "model_wall_union_ms", "tool_wall_union_ms", "host_wall_union_ms", "unclassified_wall_ms"].map(key => {
		const metric = traceMetric(run.aggregates[key]);
		return `<div class="metric"><span>${escapeTraceHtml(key)}</span><strong>${escapeTraceHtml(metric.text)}</strong>${metric.status !== "measured" ? `<small>${escapeTraceHtml(metric.status)}</small>` : ""}</div>`;
	}).join("");
	const requests = run.requests.map(request => `<tr><td>${escapeTraceHtml(request.provider ?? "")}/${escapeTraceHtml(request.model ?? "")}</td><td>${escapeTraceHtml(request.status)}</td><td>${escapeTraceHtml(traceMetric(request.metrics.provider_hook_to_message_end_ms).text)}</td></tr>`).join("");
	const tools = run.tools.map(tool => `<tr><td>${escapeTraceHtml(tool.toolName)}</td><td>${escapeTraceHtml(tool.status)}</td><td>${escapeTraceHtml(formatTraceMs(tool.durationMs ?? (tool.endMs !== undefined ? tool.endMs - tool.startMs : null)))}</td></tr>`).join("");
	return `<section class="run"><h3>${escapeTraceHtml(run.startedAt ?? run.runId)} · ${escapeTraceHtml(run.status)}</h3><div class="metrics">${cards}</div><h4>Model requests</h4>${requests ? `<table><thead><tr><th>Model</th><th>Status</th><th>Duration</th></tr></thead><tbody>${requests}</tbody></table>` : "<p>None</p>"}<h4>Tools</h4>${tools ? `<table><thead><tr><th>Tool</th><th>Status</th><th>Duration</th></tr></thead><tbody>${tools}</tbody></table>` : "<p>None</p>"}</section>`;
}

export function renderTraceExportHtml(state: UiState | null, trace: UiTraceSnapshot, exportedAt = new Date().toISOString()): string {
	const transcript = traceTranscript(state?.messages ?? []);
	const runs = trace.runs.map(exportRun).join("");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>pi-harness session ${escapeTraceHtml(trace.sessionId)}</title><style>
body{max-width:1100px;margin:0 auto;padding:32px;font:14px/1.6 system-ui,sans-serif}h1,h2,h3,h4{line-height:1.3}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;border:1px solid}section{margin-top:28px}.notice{padding:12px;border:1px solid}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.metric{padding:10px;border:1px solid}.metric span,.metric strong,.metric small{display:block;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid;text-align:left;vertical-align:top;overflow-wrap:anywhere}details{margin-top:24px}code{font-family:monospace}
</style></head><body><h1>pi-harness session export</h1><p>Exported ${escapeTraceHtml(exportedAt)} · Session <code>${escapeTraceHtml(trace.sessionId)}</code>${state?.conversationId ? ` · Conversation <code>${escapeTraceHtml(state.conversationId)}</code>` : ""}</p><p class="notice">The transcript section contains message and tool content. Trace metadata contains identifiers and timing and is not anonymous.</p><section><h2>Transcript</h2><pre>${escapeTraceHtml(transcript || "No transcript messages.")}</pre></section><section><h2>Execution trace</h2>${runs || "<p>No recorded runs.</p>"}</section><details><summary>Raw trace metadata</summary><pre>${escapeTraceHtml(JSON.stringify(trace, null, 2))}</pre></details></body></html>`;
}

export function traceExportFileName(trace: UiTraceSnapshot, format: "html" | "json"): string {
	const id = trace.sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "session";
	return `pi-harness-${id}-${format === "html" ? "session.html" : "trace.json"}`;
}
