import type { UiSubagentStep } from "./protocol.js";
const names = new Set(["source_list", "source_search", "source_read", "source_report"]);
/** Bounded UI metadata only: no tool arguments, output, or model reasoning. */
export function subagentSteps(value: unknown): UiSubagentStep[] | undefined {
	if (!Array.isArray(value)) return;
	return value.slice(0, 32).flatMap(item => {
		if (!item || typeof item !== "object") return [];
		const v = item as Record<string, unknown>;
		if (typeof v.id !== "string" || typeof v.tool !== "string" || !names.has(v.tool) || !["running", "completed", "failed", "cancelled"].includes(String(v.status))) return [];
		return [{ ...(typeof v.sourceId === "string" ? { sourceId: v.sourceId.slice(0, 160) } : {}), id: v.id.slice(0, 160), tool: v.tool as UiSubagentStep["tool"], status: v.status as UiSubagentStep["status"], ...(typeof v.target === "string" ? { target: v.target.slice(0, 160) } : {}), ...(typeof v.durationMs === "number" && Number.isFinite(v.durationMs) && v.durationMs >= 0 ? { durationMs: v.durationMs } : {}) }];
	});
}
