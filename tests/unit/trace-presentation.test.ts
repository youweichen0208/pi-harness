import { describe, expect, it } from "vitest";
import type { UiTraceRun } from "../../server/protocol.js";
import { formatTraceMs, traceMetric, traceRunsFilter, traceTimeline } from "../../web/src/trace-presentation.js";

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

	it("merges overlapping host spans and keeps every visible span inside the timeline", () => {
		const value = run({
			requests: [{ requestId: "request-1", model: "model", status: "measured", hookStartMs: 100, messageEndMs: 500, metrics: {} }],
			tools: [{ toolCallId: "tool-1", toolName: "bash", status: "measured", startMs: 600, endMs: 800 }],
			hostSpans: [{ kind: "onEvent", startMs: 110, endMs: 130 }, { kind: "snapshot_build", startMs: 120, endMs: 160 }, { kind: "ws_send", startMs: 1080, endMs: 1200 }],
		});
		const timeline = traceTimeline(value);
		expect(timeline.filter(item => item.kind === "host")).toHaveLength(2);
		for (const item of timeline) {
			expect(item.left).toBeGreaterThanOrEqual(0);
			expect(item.width).toBeGreaterThan(0);
			expect(item.left + item.width).toBeLessThanOrEqual(100);
		}
	});

	it("uses observed span ends while a run is still open", () => {
		const [item] = traceTimeline(run({ agentSettledMs: undefined, status: "open", tools: [{ toolCallId: "tool-1", toolName: "read", status: "measured", startMs: 300, endMs: 500 }] }));
		expect(item.left).toBe(50);
		expect(item.width).toBe(50);
	});
});
