import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ExecutionTraceRegistry, ExecutionTraceSession, intervalDuration, unionIntervals } from "../../server/execution-trace.js";

function emit(trace: ExecutionTraceSession, type: string, fields: Record<string, unknown> = {}): void {
	trace.observe({ type, ...fields } as AgentSessionEvent, "conversation");
}

function assistant(timestamp: number) {
	return { role: "assistant", content: [], timestamp } as Record<string, unknown>;
}

describe("ExecutionTraceSession", () => {
	it("correlates two provider requests and tools in one host request", () => {
		let clock = 0;
		const trace = new ExecutionTraceSession("session", () => clock);
		trace.promptAccepted("conversation", "host-1", "started");
		clock = 10; emit(trace, "agent_start");
		clock = 11; emit(trace, "turn_start", { turnIndex: 0 });
		clock = 20; trace.beforeProviderRequest();
		clock = 200; trace.afterProviderResponse(200);
		clock = 500; trace.providerStreamEvent("bench", "openai-completions", "model");
		const first = assistant(1);
		clock = 510; emit(trace, "message_start", { message: first });
		clock = 550; emit(trace, "message_update", { message: first, assistantMessageEvent: { type: "text_delta", delta: "x" } });
		clock = 700; emit(trace, "message_end", { message: first });
		clock = 720; emit(trace, "tool_execution_start", { toolCallId: "call-1", toolName: "bash", args: {} });
		clock = 1000; emit(trace, "tool_execution_end", { toolCallId: "call-1", toolName: "bash", result: {}, isError: false, durationMs: 280 });
		clock = 1010; emit(trace, "turn_start", { turnIndex: 1 });
		clock = 1100; trace.beforeProviderRequest();
		clock = 1200; trace.afterProviderResponse(200);
		clock = 1250; trace.providerStreamEvent("bench", "openai-completions", "model");
		const second = assistant(2);
		clock = 1260; emit(trace, "message_start", { message: second });
		clock = 1300; emit(trace, "message_update", { message: second, assistantMessageEvent: { type: "text_delta", delta: "done" } });
		clock = 1400; emit(trace, "message_end", { message: second });
		clock = 100;
		clock = 200; trace.measureHost("onEvent", 100);
		clock = 1500; emit(trace, "agent_settled", { aborted: false });

		const report = trace.report() as any;
		expect(report.coverage).toMatchObject({ provider_requests_total: 2, provider_requests_matched: 2, trace_coverage: 1 });
		const run = report.runs[0];
		expect(run.requests[0].firstOutputKind).toBe("text_delta");
		expect(run.requests[0].metrics).toMatchObject({
			provider_hook_to_headers_ms: { value: 180, status: "measured" },
			headers_to_first_provider_event_ms: { value: 300, status: "measured" },
			first_event_to_first_visible_delta_ms: { value: 50, status: "measured" },
			provider_hook_to_message_end_ms: { value: 680, status: "measured" },
		});
		expect(run.requests[1].toolToProviderGapMs).toBe(100);
		expect(run.tools[0]).toMatchObject({ assistantToToolGapMs: 20, durationMs: 280, status: "measured" });
		expect(run.aggregates).toMatchObject({
			agent_active_wall_ms: { value: 1490 },
			model_wall_union_ms: { value: 980 },
			tool_wall_union_ms: { value: 280 },
			host_wall_union_ms: { value: 100 },
			unclassified_wall_ms: { value: 230 },
			host_process_cpu_time_ms: { value: null, status: "unmeasured" },
		});
		expect(report.hostRequests[0].metrics).toMatchObject({
			task_e2e_wall_ms: { value: 1500, status: "measured" },
			agent_active_wall_ms: { value: 1490, status: "measured" },
			queue_wait_ms: { value: 10, status: "measured" },
		});
	});

	it("reports an unclosed root tool as incomplete in both aggregation scopes", () => {
		let clock = 0;
		const trace = new ExecutionTraceSession("session", () => ++clock);
		trace.promptAccepted("conversation", "host", "started");
		emit(trace, "agent_start");
		emit(trace, "tool_execution_start", { toolCallId: "open", toolName: "bash" });
		emit(trace, "agent_settled");
		const report = trace.report() as any;
		for (const metric of [report.runs[0].aggregates.tool_wall_union_ms, report.runs[0].aggregates.unclassified_wall_ms, report.hostRequests[0].metrics.unclassified_wall_ms]) {
			expect(metric).toMatchObject({ value: null, status: "unmeasured", reason: "tool_end_missing" });
		}
	});

	it("marks overlapping provider requests ambiguous instead of guessing", () => {
		let clock = 0;
		const trace = new ExecutionTraceSession("session", () => clock);
		trace.promptAccepted("conversation", "host-1", "started");
		emit(trace, "agent_start");
		clock = 1; trace.beforeProviderRequest();
		clock = 2; trace.beforeProviderRequest();
		clock = 3; trace.afterProviderResponse(200);
		clock = 4; emit(trace, "agent_settled", { aborted: false });
		const report = trace.report() as any;
		expect(report.coverage).toMatchObject({ provider_requests_total: 2, provider_requests_matched: 0, provider_requests_ambiguous: 2, trace_coverage: 0 });
		expect(report.runs[0].requests.every((request: any) => request.reasons.includes("overlapping_provider_requests"))).toBe(true);
		expect(report.runs[0].aggregates.model_wall_union_ms).toMatchObject({ value: null, status: "ambiguous", reason: "provider_requests_ambiguous" });
		expect(report.runs[0].aggregates.model_observed_lower_bound_ms).toMatchObject({ value: 0, status: "measured" });
		expect(report.runs[0].aggregates.unclassified_wall_ms).toMatchObject({ value: null, status: "ambiguous", reason: "provider_requests_ambiguous" });
		expect(report.hostRequests[0].metrics.unclassified_wall_ms).toMatchObject({ value: null, status: "ambiguous", reason: "provider_requests_ambiguous" });
	});

	it("keeps normalized assistant spans unmeasured when the provider hook is absent", () => {
		let clock = 0;
		const trace = new ExecutionTraceSession("session", () => clock);
		emit(trace, "agent_start");
		const message = assistant(1);
		clock = 10; emit(trace, "message_start", { message });
		clock = 20; emit(trace, "message_end", { message });
		const report = trace.report() as any;
		expect(report.coverage).toMatchObject({ provider_requests_unmeasured: 1 });
		expect(report.runs[0].requests[0]).toMatchObject({ normalizedStartMs: 10, messageEndMs: 20, status: "unmeasured" });
		expect(report.runs[0].requests[0].metrics.provider_hook_to_message_end_ms).toMatchObject({ value: null, status: "unmeasured" });
		expect(report.runs[0].aggregates.model_wall_union_ms).toMatchObject({ value: null, status: "unmeasured", reason: "provider_requests_unmeasured" });
		expect(report.runs[0].aggregates.unclassified_wall_ms).toMatchObject({ value: null, status: "unmeasured", reason: "provider_requests_unmeasured" });
	});

	it("uses the stable assistant timestamp when SDK event object identities differ", () => {
		let clock = 0;
		const trace = new ExecutionTraceSession("session", () => clock);
		emit(trace, "agent_start");
		clock = 1; trace.beforeProviderRequest();
		clock = 2; emit(trace, "message_start", { message: assistant(42) });
		clock = 3; emit(trace, "message_update", { message: assistant(42), assistantMessageEvent: { type: "text_delta", delta: "x" } });
		clock = 4; emit(trace, "message_end", { message: assistant(42) });
		const report = trace.report() as any;
		expect(report.runs[0].requests[0]).toMatchObject({ status: "measured", firstVisibleDeltaMs: 3, messageEndMs: 4 });
	});

	it("does not invent a queue mapping for a queued prompt", () => {
		const trace = new ExecutionTraceSession("session", () => 0);
		trace.promptAccepted("conversation", "host-queued", "queued");
		emit(trace, "agent_start");
		const report = trace.report() as any;
		expect(report.hostRequests[0]).toMatchObject({ mappingStatus: "ambiguous", reason: "queued_prompt_run_mapping_not_verified" });
		expect(report.hostRequests[0].metrics.queue_wait_ms).toMatchObject({ value: null, status: "ambiguous" });
	});
	it("uses unique UUID run identities across runs", () => {
		let clock = 0;
		const trace = new ExecutionTraceSession("session", () => clock);
		emit(trace, "agent_start");
		emit(trace, "agent_settled", { aborted: false });
		clock = 1; emit(trace, "agent_start");
		emit(trace, "agent_settled", { aborted: false });
		const report = trace.report() as any;
		expect(report.runs).toHaveLength(2);
		expect(report.runs[0].runId).not.toBe(report.runs[1].runId);
		expect(report.runs[0].runId).not.toContain("session:run-");
		expect(report.runs[0].bootId).toBe(report.runs[1].bootId);
	});

	it("bounds background requests, tools, and host requests across a long-lived session", () => {
		const trace = new ExecutionTraceSession("session", () => 0);
		for (let index = 0; index < 600; index++) {
			trace.beforeProviderRequest();
			trace.promptAccepted("conversation", `host-${index}`, "handled");
		}
		for (let index = 0; index < 300; index++) emit(trace, "tool_execution_start", { toolCallId: `background-${index}`, toolName: "bash" });
		const report = trace.report() as any;
		expect(report.coverage.provider_requests_total).toBe(512);
		expect(report.hostRequests).toHaveLength(256);
		expect(report.hostRequests[0].hostRequestId).toBe("host-344");
		expect((trace as any).tools.size).toBe(256);
	});

	it("downgrades exact attribution after host span truncation", () => {
		let clock = 0;
		const trace = new ExecutionTraceSession("session", () => clock);
		emit(trace, "agent_start");
		for (let i = 0; i < 2049; i++) {
			clock = i + 1;
			trace.measureHost("onEvent", i);
		}
		clock = 3000; emit(trace, "agent_settled", { aborted: false });
		const report = trace.report() as any;
		const run = report.runs[0];
		expect(run.hostSpans).toHaveLength(2048);
		expect(run.hostSpanOverflow.count).toBe(1);
		expect(run.aggregates.host_wall_union_ms).toMatchObject({ value: null, status: "unmeasured", reason: "host_spans_truncated" });
		expect(run.aggregates.host_observed_lower_bound_ms.value).toBe(2048);
		expect(run.aggregates.unclassified_wall_ms).toMatchObject({ value: null, status: "unmeasured", reason: "host_spans_truncated" });
	});
});

describe("ExecutionTraceRegistry", () => {
	it("is enabled by default and honors explicit off", () => {
		const previous = process.env.PI_TASK_TIMINGS;
		try {
			delete process.env.PI_TASK_TIMINGS;
			expect(new ExecutionTraceRegistry().enabled).toBe(true);
			process.env.PI_TASK_TIMINGS = "off";
			expect(new ExecutionTraceRegistry().enabled).toBe(false);
			process.env.PI_TASK_TIMINGS = "0";
			expect(new ExecutionTraceRegistry().enabled).toBe(false);
			process.env.PI_TASK_TIMINGS = "1";
			expect(new ExecutionTraceRegistry().enabled).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_TASK_TIMINGS;
			else process.env.PI_TASK_TIMINGS = previous;
		}
	});

	it("keeps queued runs visible in their conversation without inventing a host mapping", () => {
		const registry = new ExecutionTraceRegistry();
		const trace = registry.forSession("session")!;
		trace.promptAccepted("conversation", "host-queued", "queued");
		emit(trace, "agent_start");
		emit(trace, "agent_settled", { aborted: false });
		const report = registry.reportSession("session", "conversation") as any;
		expect(report.runs).toHaveLength(1);
		expect(report.runs[0]).toMatchObject({ conversationId: "conversation", status: "measured" });
		expect(report.hostRequests[0]).toMatchObject({ mappingStatus: "ambiguous", reason: "queued_prompt_run_mapping_not_verified" });
	});
});

describe("trace intervals", () => {
	it("unions parallel and nested intervals without double counting", () => {
		const intervals = unionIntervals([
			{ startMs: 0, endMs: 100 },
			{ startMs: 50, endMs: 150 },
			{ startMs: 25, endMs: 75 },
			{ startMs: 200, endMs: 250 },
			{ startMs: 250, endMs: 275 },
		]);
		expect(intervals).toEqual([{ startMs: 0, endMs: 150 }, { startMs: 200, endMs: 275 }]);
		expect(intervalDuration(intervals)).toBe(225);
	});
});
