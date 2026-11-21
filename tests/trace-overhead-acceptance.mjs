/** Formal zero-token Trace off/summary acceptance. Real server + SDK + local SSE. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { scrubHostEnv } from "./lib/test-env.mjs";

scrubHostEnv();
const args = Object.fromEntries(process.argv.slice(2).filter(value => value.startsWith("--") && value.includes("=")).map(value => { const index = value.indexOf("="); return [value.slice(2, index), value.slice(index + 1)]; }));
const rounds = Number(args.rounds ?? "3");
const churnSessions = Number(args.sessions ?? "40");
const scenarios = (args.scenarios ?? "text,bash,tools20,long-history,churn").split(",").filter(Boolean);
const out = resolve(args.out ?? "docs/review-data/trace-overhead-acceptance.json");
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, "rounds must be an integer from 1 to 10");
assert(Number.isInteger(churnSessions) && churnSessions >= 4 && churnSessions <= 100, "sessions must be an integer from 4 to 100");
const known = new Set(["text", "bash", "tools20", "long-history", "churn"]);
for (const scenario of scenarios) assert(known.has(scenario), `unknown scenario ${scenario}`);
const { PROTOCOL_VERSION } = await import("../dist/server/protocol-version.js");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const base = mkdtempSync(join(tmpdir(), "pi-trace-acceptance-"));
const work = join(base, "work"), configTemplate = join(base, "config"), longTemplate = join(base, "long-agent");
mkdirSync(work, { recursive: true });
const probeImport = pathToFileURL(resolve("tests/fixtures/resource-probe.mjs")).href;
const results = [];
let mock, harness, ws;
let requestSeq = 0;

const textOf = content => Array.isArray(content) ? content.filter(block => block?.type === "text").map(block => block.text).join("\n") : String(content ?? "");
const chunk = (res, delta, finishReason = null) => res.write(`data: ${JSON.stringify({ id: "trace-acceptance", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(finishReason ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`);
function writeConfig(directory) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: "fixture", models: [{ id: "fixture", input: ["text"], contextWindow: 200000, maxTokens: 4096 }] } } }));
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
	writeFileSync(join(directory, "webui-extensions.json"), JSON.stringify({ autoCheck: false }));
}

const mockPort = await (async () => {
	mock = createServer((req, res) => { void (async () => {
		let raw = ""; for await (const part of req) raw += part;
		const body = JSON.parse(raw);
		const lastUser = body.messages.filter(message => message.role === "user").at(-1);
		const marker = textOf(lastUser?.content).match(/\[TRACE_ACCEPT:([a-z0-9-]+)\]/);
		assert(marker, "mock receives the current acceptance marker");
		const scenario = marker[1];
		const toolResults = body.messages.filter(message => message.role === "tool").length;
		await sleep(20);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.flushHeaders();
		await sleep(20);
		chunk(res, { role: "assistant", content: "" });
		if ((scenario === "bash" && toolResults === 0) || (scenario === "tools20" && toolResults < 20)) {
			chunk(res, { tool_calls: [{ index: 0, id: `accept-${++requestSeq}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "node -e \"process.stdout.write('accept')\"" }) } }] });
			chunk(res, {}, "tool_calls");
		} else {
			chunk(res, { content: `TRACE_ACCEPT_OK:${scenario}` });
			chunk(res, {}, "stop");
		}
		res.end("data: [DONE]\n\n");
	})().catch(error => res.destroy(error)); });
	return listenIsolated(mock);
})();
writeConfig(configTemplate);
const longManager = SessionManager.create(work);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
for (let index = 0; index < 400; index++) {
	const timestamp = Date.now() + index * 4;
	longManager.appendMessage({ role: "user", content: [{ type: "text", text: `fixture question ${index}` }], timestamp });
	longManager.appendMessage({ role: "assistant", content: [{ type: "text", text: `fixture answer ${index}` }], api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp });
	const toolCallId = `fixture-${index}`;
	longManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: `fixture-${index}.txt` } }], api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason: "toolUse", timestamp });
	longManager.appendMessage({ role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: `fixture-${index}\n` + "x".repeat(8192) }], isError: false, timestamp, durationMs: 1 });
}
writeConfig(longTemplate);

class Client {
	constructor(socket) {
		this.ws = socket; this.received = []; this.state = null;
		socket.on("message", raw => {
			const message = JSON.parse(raw.toString()); this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "snapshot_delta" && this.state && message.baseRev === this.state.rev) this.state = { ...this.state, ...message.state, messages: [...this.state.messages, ...message.appended] };
			else if (message.type === "snapshot_delta") this.send({ type: "get_state" });
		});
	}
	send(message) { this.ws.send(JSON.stringify(message)); }
	async waitFor(predicate, timeoutMs = 45000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const value = predicate(this.state, this.received);
			if (value) return value;
			await sleep(2);
		}
		throw new Error(`acceptance client timeout: ${JSON.stringify({ state: this.state && { streaming: this.state.isStreaming, error: this.state.errorMessage }, notices: this.received.filter(message => message.type === "notice").slice(-3) })}`);
	}
	async prompt(text, scenario, expectedTools) {
		const requestId = `accept-${scenario}-${++requestSeq}`, started = performance.now();
		this.send({ type: "prompt", requestId, text });
		await this.waitFor((state, received) => {
			if (!state || state.isStreaming || !received.some(message => message.type === "prompt_result" && message.requestId === requestId && message.ok)) return false;
			const markerIndex = state.messages.findLastIndex(message => message.role === "user" && textOf(message.content).includes(text));
			if (markerIndex < 0) return false;
			const turn = state.messages.slice(markerIndex + 1);
			return turn.some(message => message.role === "assistant" && textOf(message.content).includes(`TRACE_ACCEPT_OK:${scenario}`));
		});
		const latencyMs = performance.now() - started;
		const markerIndex = this.state.messages.findLastIndex(message => message.role === "user" && textOf(message.content).includes(text));
		const turn = this.state.messages.slice(markerIndex + 1);
		const toolResults = turn.filter(message => message.role === "toolResult");
		assert.equal(toolResults.length, expectedTools, `${scenario} tool result count`);
		assert(toolResults.every(message => !message.isError), `${scenario} tools succeed`);
		return { latencyMs, toolCalls: turn.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall") : []).length, toolResults: toolResults.length };
	}
	async newProject(path, previousSessionId) {
		this.send({ type: "set_cwd", path, source: "ui" });
		await this.waitFor(state => state?.cwd === path && state.sessionId && state.sessionId !== previousSessionId && !state.isStreaming && state.tree?.verifying === false);
		return this.state.sessionId;
	}
	async trace(conversationId) {
		const reqId = `trace-report-${++requestSeq}`;
		this.send({ type: "trace_get", reqId, conversationId });
		return this.waitFor((_state, received) => received.find(message => message.type === "trace_result" && message.reqId === reqId)?.trace);
	}
}

function probeSamples(directory, pid) {
	const path = join(directory, "process.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(sample => sample.pid === pid);
}
function memoryRecord(sample) {
	return { time: sample.time, gc: sample.gc, rssBytes: sample.memory.rss, heapUsedBytes: sample.memory.heapUsed, heapTotalBytes: sample.memory.heapTotal, externalBytes: sample.memory.external, arrayBuffersBytes: sample.memory.arrayBuffers };
}
async function memory(directory, pid, gc) {
	const mark = Date.now();
	if (gc) writeFileSync(join(directory, `gc-${pid}`), "");
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		const samples = probeSamples(directory, pid);
		const sample = gc ? samples.find(value => value.gc && value.time >= mark) : samples.at(-1);
		if (sample) return memoryRecord(sample);
		await sleep(25);
	}
	throw new Error(`resource probe did not produce ${gc ? "post-GC" : "natural"} sample`);
}
function diskMetrics(dataDir) {
	const directory = join(dataDir, "traces");
	if (!existsSync(directory)) return { files: 0, bytes: 0, retainedRecords: 0 };
	const files = readdirSync(directory).filter(name => name.endsWith(".jsonl"));
	let bytes = 0, retainedRecords = 0;
	for (const name of files) {
		const path = join(directory, name); bytes += statSync(path).size;
		retainedRecords += readFileSync(path, "utf8").split("\n").filter(Boolean).length;
	}
	return { files: files.length, bytes, retainedRecords };
}
function persistenceMetrics(trace, disk) {
	const persistence = trace?.persistence ?? {};
	return { ...disk, appendAttempts: persistence.appendAttempts ?? 0, appendedRecords: persistence.appendedRecords ?? 0, compactions: persistence.compactions ?? 0, prunedFiles: persistence.prunedFiles ?? 0, state: persistence.state ?? "unmeasured" };
}

async function runCell(scenario, round, mode, order) {
	const label = `${scenario}-r${round}-${mode}`;
	const agentDir = join(base, `${label}-agent`), dataDir = join(base, `${label}-data`), probe = join(base, `${label}-probe`);
	cpSync(scenario === "long-history" ? longTemplate : configTemplate, agentDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true }); mkdirSync(probe, { recursive: true });
	writeFileSync(join(dataDir, "design-first.json"), JSON.stringify({ enabled: false }));
	harness = await startIsolatedHarness({ env: {
		PI_WEB_CWD: work, PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_NO_BROWSER: "1", PI_WEB_CLIENT_IDLE_MINUTES: "0",
		PI_TASK_TIMINGS: mode === "off" ? "off" : "1", PI_SNAPSHOT_TIMINGS: mode === "off" ? "off" : "summary",
		PI_RESOURCE_PROBE: probe, NODE_OPTIONS: `--import=${probeImport}`,
	} });
	try {
		ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
		await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
		const client = new Client(ws);
		client.send({ type: "hello", clientId: `trace-acceptance-${label}`, protocolVersion: PROTOCOL_VERSION });
		await client.waitFor(state => state?.sessionId && state.model?.id === "fixture" && state.tree?.verifying === false);
		const memoryBefore = await memory(probe, harness.child.pid, true);
		const diskBefore = diskMetrics(dataDir);
		const runs = [], checkpoints = [];
		if (scenario === "churn") {
			let sessionId = client.state.sessionId;
			for (let index = 0; index < churnSessions; index++) {
				if (index) {
					const path = join(base, `${label}-project-${index}`); mkdirSync(path, { recursive: true });
					sessionId = await client.newProject(path, sessionId);
				}
				runs.push(await client.prompt(`[TRACE_ACCEPT:churn] session ${index}`, "churn", 0));
				if ((index + 1) % 10 === 0 || index + 1 === churnSessions) {
					const trace = await client.trace(client.state.conversationId);
					checkpoints.push({ sessions: index + 1, memory: await memory(probe, harness.child.pid, false), persistence: persistenceMetrics(trace, diskMetrics(dataDir)) });
				}
			}
		} else {
			const expectedTools = scenario === "bash" ? 1 : scenario === "tools20" ? 20 : 0;
			runs.push(await client.prompt(`[TRACE_ACCEPT:${scenario}] controlled acceptance`, scenario, expectedTools));
		}
		const memoryAfter = await memory(probe, harness.child.pid, false);
		const trace = await client.trace(client.state.conversationId);
		const persistence = persistenceMetrics(trace, diskMetrics(dataDir));
		const memoryRetained = await memory(probe, harness.child.pid, true);
		if (mode === "off") {
			assert.equal(persistence.appendAttempts, 0, "off performs no trace appends");
			assert.equal(persistence.bytes, 0, "off creates no trace data");
		} else {
			const expectedRuns = scenario === "churn" ? churnSessions : 1;
			const expectedRequests = scenario === "tools20" ? 21 : scenario === "bash" ? 2 : expectedRuns;
			const expectedAppends = expectedRuns * 2 + expectedRequests + (scenario === "tools20" ? 20 : scenario === "bash" ? 1 : 0);
			assert.equal(persistence.appendAttempts, expectedAppends, "summary writes exactly run/request/tool/settle events");
			assert(persistence.bytes > 0, "summary creates trace data");
		}
		const samples = probeSamples(probe, harness.child.pid);
		return {
			scenario, round, mode, order, runs,
			latencyMs: runs.reduce((total, run) => total + run.latencyMs, 0),
			toolCalls: runs.reduce((total, run) => total + run.toolCalls, 0), toolResults: runs.reduce((total, run) => total + run.toolResults, 0),
			memory: { before: memoryBefore, after: memoryAfter, retained: memoryRetained, retainedHeapDeltaBytes: memoryRetained.heapUsedBytes - memoryBefore.heapUsedBytes, retainedRssDeltaBytes: memoryRetained.rssBytes - memoryBefore.rssBytes, peakRssBytes: Math.max(...samples.map(sample => sample.memory.rss)), peakHeapUsedBytes: Math.max(...samples.map(sample => sample.memory.heapUsed)) },
			persistence: { ...persistence, bytesDelta: persistence.bytes - diskBefore.bytes }, checkpoints,
		};
	} finally {
		ws?.close(); ws = undefined;
		await harness.stop(); harness = undefined;
	}
}

function stats(values) {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (!sorted.length) return null;
	const quantile = q => { const position = (sorted.length - 1) * q, lower = Math.floor(position), upper = Math.ceil(position); return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower); };
	return { count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, p50: quantile(0.5), p95: quantile(0.95), min: sorted[0], max: sorted.at(-1) };
}
function compare(scenario) {
	const cells = results.filter(result => result.scenario === scenario);
	const off = cells.filter(result => result.mode === "off"), on = cells.filter(result => result.mode === "summary");
	const metric = selector => ({ off: stats(off.map(selector)), summary: stats(on.map(selector)) });
	const offMedian = stats(off.map(result => result.latencyMs))?.p50, onMedian = stats(on.map(result => result.latencyMs))?.p50;
	return {
		scenario, samples: { off: off.length, summary: on.length },
		latencyMs: { ...metric(result => result.latencyMs), medianDelta: onMedian - offMedian, medianRatio: onMedian / offMedian },
		retainedHeapDeltaBytes: metric(result => result.memory.retainedHeapDeltaBytes),
		retainedRssDeltaBytes: metric(result => result.memory.retainedRssDeltaBytes),
		postGcHeapUsedBytes: metric(result => result.memory.retained.heapUsedBytes),
		postGcRssBytes: metric(result => result.memory.retained.rssBytes),
		peakRssBytes: metric(result => result.memory.peakRssBytes),
		traceAppendAttempts: metric(result => result.persistence.appendAttempts),
		traceFileBytes: metric(result => result.persistence.bytes),
		traceFiles: metric(result => result.persistence.files),
	};
}

try {
	for (const [scenarioIndex, scenario] of scenarios.entries()) for (let round = 1; round <= rounds; round++) {
		const modes = (scenarioIndex + round) % 2 ? ["off", "summary"] : ["summary", "off"];
		for (const [order, mode] of modes.entries()) {
			console.error(`[trace-acceptance] ${scenario} round ${round}/${rounds} ${mode} (${order === 0 ? "first" : "second"})`);
			results.push(await runCell(scenario, round, mode, order));
		}
	}
	const report = {
		schemaVersion: 1, generatedAt: new Date().toISOString(), rounds, churnSessions, scenarios,
		design: { fixture: "local OpenAI-compatible SSE; 20ms to headers + 20ms to body", interleaving: "AB/BA alternated by scenario and round", modes: { off: "PI_TASK_TIMINGS=off PI_SNAPSHOT_TIMINGS=off", summary: "PI_TASK_TIMINGS=1 PI_SNAPSHOT_TIMINGS=summary" }, memory: "server process only; test preload process.memoryUsage(); natural and post-GC samples", latency: "WS prompt send to correct final canary and settled snapshot", performanceGate: "comparison only; no unapproved latency/RSS threshold" },
		environment: { node: process.version, platform: `${platform()}/${arch()}`, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() },
		comparisons: scenarios.map(compare), results,
	};
	mkdirSync(resolve(out, ".."), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
	for (const comparison of report.comparisons) console.log(JSON.stringify({ scenario: comparison.scenario, latency: comparison.latencyMs, retainedHeapDeltaBytes: comparison.retainedHeapDeltaBytes, traceFileBytes: comparison.traceFileBytes }));
	console.log(`PASS trace acceptance: ${results.length} controlled cells, correct canaries/tool counts; results: ${out}`);
} finally {
	ws?.close(); await harness?.stop();
	if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
	rmSync(base, { recursive: true, force: true });
}
