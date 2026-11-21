import { describe, expect, it } from "vitest";
import type { UiState, UiTraceSnapshot } from "../../server/protocol.js";
import { escapeTraceHtml, renderTraceExportHtml, traceExportFileName, traceTranscript } from "../../web/src/trace-export.js";

const attack = `</pre><script>globalThis.__traceExportExecuted=true</script><iframe src="https://invalid.example"></iframe><meta http-equiv="refresh" content="0;url=https://invalid.example"><img src=x onerror=alert(1)><a href="javascript:alert(1)">click</a> & \"'`;
const trace: UiTraceSnapshot = {
	schemaVersion: 1, sessionId: "session-<unsafe>", runs: [{ runId: "run-1", sessionId: "session-<unsafe>", agentStartMs: 0, agentSettledMs: 10, status: "measured", requests: [{ requestId: "request-1", provider: "provider<iframe>", model: "model</td><script>alert(1)</script>", status: "measured", metrics: {} }], tools: [{ toolCallId: "tool-1", toolName: "extension<script>", startMs: 1, endMs: 3, status: "measured" }], hostSpans: [], aggregates: { host_wall_union_ms: { value: null, status: "unmeasured", reason: "run_open" } } }],
	hostRequests: [], coverage: { provider_requests_total: 0, provider_requests_matched: 0, trace_coverage: null, scope: "identified_requests_only" }, persistence: { state: "ready" }, privacy: { containsMessageContent: false, anonymous: false, notice: "Not anonymous" },
};
const state = { conversationId: "conversation-<script>", messages: [
	{ id: "message-1", role: "user", content: [{ type: "text" as const, text: attack }] },
	{ id: "message-2", role: "custom<script>", provider: "extension<iframe>", model: "model</code>", content: [{ type: "custom", text: attack }], errorMessage: attack },
] } as unknown as UiState;

describe("trace export", () => {
	it("escapes transcript, extension, tool, model and identifier fields in every HTML context", () => {
		const html = renderTraceExportHtml(state, trace, "2026-01-01T00:00:00.000Z");
		expect(html).toContain(escapeTraceHtml(attack));
		expect(html).toContain("extension&lt;script&gt;");
		expect(html).toContain("session-&lt;unsafe&gt;");
		expect(html).toContain("conversation-&lt;script&gt;");
		expect(html).toContain("model&lt;/td&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
		for (const raw of ["<script", "<iframe", "<img", "<meta http-equiv=\"refresh\"", 'href="javascript:'] ) expect(html).not.toContain(raw);
		expect(html).toContain("default-src 'none'");
		expect(html).toContain("base-uri 'none'");
		expect(html).toContain("form-action 'none'");
	});

	it("exports transcript blocks as text rather than interpolating raw markup", () => {
		expect(traceTranscript(state.messages)).toContain(attack);
		expect(escapeTraceHtml("\"'<>&")).toBe("&quot;&#39;&lt;&gt;&amp;");
	});

	it("uses a safe local filename even for traversal and markup characters", () => {
		const malicious = { ...trace, sessionId: "../../session-<unsafe>" };
		for (const format of ["html", "json"] as const) {
			const name = traceExportFileName(malicious, format);
			expect(name).not.toMatch(/[\\/<>]/);
			expect(name.startsWith("pi-harness-")).toBe(true);
			expect(name.endsWith(format === "html" ? "-session.html" : "-trace.json")).toBe(true);
		}
	});
});
