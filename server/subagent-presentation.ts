import type { UiSubagentProgress } from "./protocol.js";

const phases = new Set<UiSubagentProgress["phase"]>(["queued", "running", "completed", "failed", "cancelled"]);
const tools = new Set(["source_list", "source_search", "source_read", "source_report"]);

/** Allowlist live subagent metadata; never forward arbitrary extension details. */
export function subagentProgressDetails(value: unknown): UiSubagentProgress[] | undefined {
	if (!value || typeof value !== "object" || !Array.isArray((value as { subagents?: unknown }).subagents)) return;
	const input = (value as { subagents: unknown[] }).subagents;
	const output: UiSubagentProgress[] = [];
	for (const item of input.slice(0, 8)) {
		if (!item || typeof item !== "object") continue;
		const raw = item as Record<string, unknown>;
		if (typeof raw.sourceId !== "string" || typeof raw.source !== "string" || typeof raw.root !== "string" || typeof raw.task !== "string" || typeof raw.phase !== "string" || !phases.has(raw.phase as UiSubagentProgress["phase"])) continue;
		output.push({
			sourceId: raw.sourceId.slice(0, 160),
			source: raw.source.slice(0, 240),
			root: raw.root.slice(0, 4096),
			task: raw.task.slice(0, 500),
			phase: raw.phase as UiSubagentProgress["phase"],
			...(typeof raw.tool === "string" && tools.has(raw.tool) ? { tool: raw.tool as UiSubagentProgress["tool"] } : {}),
		});
	}
	return output;
}
