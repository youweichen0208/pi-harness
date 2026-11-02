import { subagentSteps } from "./subagent-steps.js";
import type { UiSubagentProgress } from "./protocol.js";

const phases = new Set<UiSubagentProgress["phase"]>(["queued", "running", "stopping", "completed", "failed", "cancelled"]);
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
			...(Number.isInteger(raw.taskIndex) && Number(raw.taskIndex) >= 0 && Number(raw.taskIndex) < 8 ? { taskIndex: Number(raw.taskIndex) } : {}),
			...(typeof raw.taskId === "string" ? { taskId: raw.taskId.slice(0, 160) } : {}),
			...(typeof raw.title === "string" ? { title: raw.title.slice(0, 120) } : {}),
			...(typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt) ? { startedAt: raw.startedAt } : {}),
			...(typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
			...(Array.isArray(raw.sources) ? { sources: raw.sources.slice(0, 8).flatMap(value => {
				if (!value || typeof value !== "object") return [];
				const source = value as Record<string, unknown>;
				return typeof source.id === "string" && typeof source.name === "string" && typeof source.root === "string" && (source.kind === "repository" || source.kind === "knowledge") ? [{ id: source.id.slice(0, 160), name: source.name.slice(0, 240), root: source.root.slice(0, 4096), kind: source.kind }] : [];
			}) } : {}),
			sourceId: raw.sourceId.slice(0, 160),
			source: raw.source.slice(0, 240),
			root: raw.root.slice(0, 4096),
			task: raw.task.slice(0, 500),
			phase: raw.phase as UiSubagentProgress["phase"],
			...(Array.isArray(raw.steps) ? { steps: subagentSteps(raw.steps) } : {}),
			...(typeof raw.tool === "string" && tools.has(raw.tool) ? { tool: raw.tool as UiSubagentProgress["tool"] } : {}),
		});
	}
	return output;
}

/** Persisted results use status, unlike live progress. Never expose native details. */
export function subagentResultDetails(value: unknown): UiSubagentProgress[] | undefined {
	if (!value || typeof value !== "object" || !Array.isArray((value as { subagents?: unknown }).subagents)) return;
	return subagentProgressDetails({ subagents: (value as { subagents: unknown[] }).subagents.slice(0, 8).flatMap(item => {
		if (!item || typeof item !== "object") return [];
		const raw = item as Record<string, unknown>;
		if (!["completed", "failed", "cancelled"].includes(String(raw.status))) return [];
		return [{ ...raw, phase: raw.status, tool: undefined }];
	}) });
}
