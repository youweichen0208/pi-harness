import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { scrubHostEnv } from "./lib/test-env.mjs";

scrubHostEnv();
const { PROTOCOL_VERSION } = await import("../dist/server/protocol-version.js");
const base = mkdtempSync(join(tmpdir(), "pi-execution-trace-"));
const cwd = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const traceOut = join(base, "trace.json");
for (const dir of [cwd, dataDir, agentDir]) mkdirSync(dir, { recursive: true });

const requests = [];
const mock = createServer((req, res) => {
	void (async () => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		requests.push(body);
		const hasToolResult = body.messages.some(message => message.role === "tool");
		await sleep(200);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.flushHeaders();
		await sleep(500);
		const chunk = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({ id: "trace", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(finishReason ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`);
		if (!hasToolResult) {
			chunk({ role: "assistant", content: "" });
			chunk({ tool_calls: [{ index: 0, id: "call-trace", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "node -e 'setTimeout(() => process.exit(0), 1000)'" }) } }] });
			chunk({}, "tool_calls");
		} else {
			chunk({ role: "assistant", content: "" });
			chunk({ content: "TRACE_DONE" });
			chunk({}, "stop");
		}
		res.end("data: [DONE]\n\n");
	})().catch(error => { res.destroy(error); });
});
const mockPort = await listenIsolated(mock);
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { main: {
	api: "openai-completions", baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: "trace",
	models: [{ id: "trace-model", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
} } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "main", defaultModel: "trace-model", retry: { enabled: false }, compaction: { enabled: false } }));

const server = await startIsolatedHarness({ env: {
	PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir,
	PI_WEB_NO_BROWSER: "1", PI_TASK_TIMINGS_OUT: traceOut,
} });
let ws;
try {
	ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	const received = [];
	let state;
	ws.on("message", raw => {
		const message = JSON.parse(raw.toString());
		received.push(message);
		if (message.type === "snapshot") state = message.state;
		else if (message.type === "snapshot_delta" && state && message.baseRev === state.rev) state = { ...state, ...message.state, messages: [...state.messages, ...message.appended] };
	});
	const send = message => ws.send(JSON.stringify(message));
	const waitFor = async (predicate, timeoutMs = 20000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const value = predicate();
			if (value) return value;
			await sleep(20);
		}
		throw new Error(`timed out waiting for execution trace fixture: ${JSON.stringify({ notices: received.filter(message => message.type === "notice" || message.type === "prompt_result" || message.type === "agent_settled"), state: state && { streaming: state.isStreaming, error: state.errorMessage, messages: state.messages?.slice(-4) }, requestCount: requests.length, logs: server.logs })}`);
	};
	send({ type: "hello", clientId: "execution-trace-contract", protocolVersion: PROTOCOL_VERSION });
	await waitFor(() => state?.sessionId && state.model?.id === "trace-model");
	send({ type: "prompt", requestId: "trace-host-request", text: "Run the controlled bash step, then reply TRACE_DONE." });
	await waitFor(() => received.some(message => message.type === "prompt_result" && message.requestId === "trace-host-request" && message.ok));
	send({ type: "prompt", requestId: "trace-host-queued", text: "Queue a follow-up within the traced run.", queue: true });
	await waitFor(() => received.some(message => message.type === "prompt_result" && message.requestId === "trace-host-queued" && message.ok));
	await waitFor(() => state?.isStreaming === false && state.messages.some(message => message.role === "toolResult" && message.toolCallId === "call-trace") && state.messages.filter(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text.includes("TRACE_DONE"))).length >= 2);
	assert.equal(requests.length, 3, "mock runs the direct tool flow and one queued follow-up");
	send({ type: "trace_get", reqId: "trace-view", conversationId: state.conversationId });
	const traceView = await waitFor(() => received.find(message => message.type === "trace_result" && message.reqId === "trace-view"));
	assert.equal(traceView.trace.runs.length, 1, "run containing a queued prompt remains visible in its conversation");
	assert(traceView.trace.runs.every(run => run.conversationId === state.conversationId));
} finally {
	ws?.close();
	await server.stop();
	await new Promise(resolve => mock.close(resolve));
}

const trace = JSON.parse(readFileSync(traceOut, "utf8"));
assert(readdirSync(join(dataDir, "traces")).some(name => name.endsWith(".jsonl")), "default trace collection must persist run events");
const session = Object.values(trace.clients)[0].sessions;
const sessionTrace = Object.values(session)[0];
assert.equal(sessionTrace.coverage.provider_requests_total, 3);
assert.equal(sessionTrace.coverage.provider_requests_matched, 3);
assert.equal(sessionTrace.coverage.trace_coverage, 1);
assert.equal(sessionTrace.runs.length, 1);
const run = sessionTrace.runs[0];
assert.equal(run.status, "measured");
assert.equal(run.requests.length, 3);
assert.equal(run.tools.length, 1);
const [first, second] = run.requests;
assert(first.metrics.provider_hook_to_headers_ms.value >= 150, JSON.stringify(first));
assert(first.metrics.headers_to_first_provider_event_ms.value >= 400, JSON.stringify(first));
assert(first.metrics.provider_hook_to_message_end_ms.value >= 600, JSON.stringify(first));
assert(run.tools[0].durationMs >= 900, JSON.stringify(run.tools[0]));
assert(run.tools[0].assistantToToolGapMs >= 0);
assert(second.toolToProviderGapMs >= 0);
const host = sessionTrace.hostRequests.find(request => request.hostRequestId === "trace-host-request");
assert.equal(host.mappingStatus, "measured");
assert(host.metrics.task_e2e_wall_ms.value >= 2000, JSON.stringify(host));
assert(host.metrics.queue_wait_ms.value >= 0);
assert(host.metrics.agent_active_wall_ms.value <= host.metrics.task_e2e_wall_ms.value);
assert(run.aggregates.model_wall_union_ms.value >= 1200);
assert(run.aggregates.tool_wall_union_ms.value >= 900);
assert(run.aggregates.host_wall_union_ms.value >= 0);
console.log("PASS execution trace: provider hooks, queued-run visibility, message identity, tool scheduling gaps and delayed spans");
rmSync(base, { recursive: true, force: true });
