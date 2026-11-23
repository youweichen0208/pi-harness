import { describe, expect, it } from "vitest";
import type { UiTraceRun } from "../../server/protocol.js";
import { formatTraceMs, traceMetric, traceRunsFilter, traceShare, mergeHostIntervals } from "../../web/src/trace-presentation.js";

function run(overrides: Partial<UiTraceRun> = {}): UiTraceRun {
	return {
		runId: "run-1", sessionId: "session-1", agentStartMs: 100, agentSettledMs: 1100, status: "measured",
		requests: [], tools: [], hostSpans: [], aggregates: {}, ...overrides,
	};
}

describe("trace presentation", () => {
	it("formats durations without turning missing or negative values into zero", () => {
		expect(formatTraceMs(null)).toBe("—");
		expect(formatTraceMs(0.25)).toBe("250µs");
		expect(formatTraceMs(-500)).toBe("-500.0ms");
		expect(formatTraceMs(1250)).toBe("1.25s");
		expect(traceMetric({ value: null, status: "unmeasured", reason: "run_open" })).toEqual({ text: "unmeasured", status: "unmeasured" });
	});

	it("filters runs by provider, model, tool, and status", () => {
		const target = run({ requests: [{ requestId: "request-1", provider: "deepseek", model: "deepseek-chat", status: "measured", metrics: {} }], tools: [{ toolCallId: "tool-1", toolName: "bash", startMs: 200, status: "measured" }] });
		expect(traceRunsFilter([run(), target], "DEEPSEEK")).toEqual([target]);
		expect(traceRunsFilter([run(), target], "bash")).toEqual([target]);
		expect(traceRunsFilter([run(), target], "missing")).toEqual([]);
	});

	it("clips and merges overlapping spans within one host category", () => {
		expect(mergeHostIntervals([{start:0,end:20},{start:9,end:24},{start:30,end:40}], 4, 38))
			.toEqual([{start:4,end:24},{start:30,end:38}]);
	});
	it("computes shares from raw measurements and omits missing percentages", () => {
		const sample = run({aggregates: {agent_active_wall_ms:{status:"measured",value:4770},model_wall_union_ms:{status:"measured",value:4700}}});
		expect(traceShare(sample, "model_wall_union_ms")).toBe("98.5%");
		expect(traceShare(sample, "host_wall_union_ms")).toBe("");
	});
});
