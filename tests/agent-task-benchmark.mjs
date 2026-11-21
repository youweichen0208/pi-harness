import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { scrubHostEnv } from "./lib/test-env.mjs";

scrubHostEnv();
const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith("--") && arg.includes("=")).map(arg => { const index = arg.indexOf("="); return [arg.slice(2, index), arg.slice(index + 1)]; }));
const mockMode = process.argv.includes("--mock");
const modelArg = args.model ?? (mockMode ? "main/bench-task" : "");
if (!modelArg) throw new Error("Pass --model=provider/model, or use --mock for the zero-token fixture");
const rounds = Number(args.rounds ?? "1");
const timeoutMs = Number(args.timeout ?? (mockMode ? "20000" : "120000"));
const selectedTasks = (args.tasks ?? "text,read,bash,write").split(",").filter(Boolean);
const out = resolve(args.out ?? (mockMode ? "docs/review-data/agent-task-trace-mock.json" : "docs/review-data/agent-task-latency.json"));
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error("rounds must be an integer from 1 to 20");
const { PROTOCOL_VERSION } = await import("../dist/server/protocol-version.js");
const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "pi-agent-task-benchmark-"));
const mockAgentDir = join(base, "mock-agent");
mkdirSync(mockAgentDir, { recursive: true });

const textOf = content => Array.isArray(content) ? content.filter(block => block?.type === "text").map(block => block.text).join("\n") : String(content ?? "");
const taskDefinitions = {
	text: {
		prompt: cwd => `[PI_BENCH_TEXT] Reply with exactly PI_TEXT_OK and nothing else. Do not use tools. Workspace: ${cwd}`,
		tools: [], canary: "PI_TEXT_OK",
	},
	read: {
		prompt: cwd => `[PI_BENCH_READ] Use read exactly once on ${join(cwd, "input.txt")}. Then reply with exactly PI_READ_OK_7F3A and nothing else. Do not use other tools.`,
		tools: ["read"], canary: "PI_READ_OK_7F3A",
	},
	bash: {
		prompt: () => `[PI_BENCH_BASH] Use bash exactly once to run: node -e "console.log('PI_BASH_OK_91C2')". Then reply with exactly PI_BASH_OK_91C2 and nothing else. Do not use other tools.`,
		tools: ["bash"], canary: "PI_BASH_OK_91C2",
	},
	write: {
		prompt: cwd => `[PI_BENCH_WRITE] Use write exactly once to create ${join(cwd, "result.txt")} with exact content PI_WRITE_OK_4D8B followed by one newline. Then reply with exactly PI_WRITE_OK_4D8B and nothing else. Do not use other tools.`,
		tools: ["write"], canary: "PI_WRITE_OK_4D8B",
	},
};
for (const task of selectedTasks) assert(taskDefinitions[task], `unknown task ${task}`);

let mock;
let mockPort;
if (mockMode) {
	mock = createServer((req, res) => {
		void (async () => {
			let raw = "";
			for await (const chunk of req) raw += chunk;
			const body = JSON.parse(raw);
			const allText = body.messages.map(message => textOf(message.content)).join("\n");
			const task = selectedTasks.find(id => allText.includes(`[PI_BENCH_${id.toUpperCase()}]`));
			assert(task, "mock request contains a benchmark task marker");
			const hasToolResult = body.messages.some(message => message.role === "tool");
			await sleep(50);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.flushHeaders();
			await sleep(50);
			const chunk = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({ id: "task-bench", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(finishReason ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`);
			chunk({ role: "assistant", content: "" });
			if (!hasToolResult && task !== "text") {
				const cwd = allText.match(/Workspace: ([^\n]+)/)?.[1];
				const call = task === "read"
					? { name: "read", arguments: JSON.stringify({ path: allText.match(/read exactly once on ([^\.\n]+(?:\.[^\.\n]+)?)/)?.[1]?.trim() ?? allText.match(/Use read exactly once on (.+?)\. Then/)?.[1] }) }
					: task === "bash"
						? { name: "bash", arguments: JSON.stringify({ command: "node -e \"console.log('PI_BASH_OK_91C2')\"" }) }
						: { name: "write", arguments: JSON.stringify({ path: allText.match(/create (.+?) with exact content/)?.[1], content: "PI_WRITE_OK_4D8B\n" }) };
				chunk({ tool_calls: [{ index: 0, id: `call-${task}`, type: "function", function: call }] }, null);
				chunk({}, "tool_calls");
			} else {
				chunk({ content: taskDefinitions[task].canary });
				chunk({}, "stop");
			}
			res.end("data: [DONE]\n\n");
		})().catch(error => res.destroy(error));
	});
	mockPort = await listenIsolated(mock);
	writeFileSync(join(mockAgentDir, "models.json"), JSON.stringify({ providers: { main: {
		api: "openai-completions", baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: "bench",
		models: [{ id: "bench-task", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
	} } }));
	writeFileSync(join(mockAgentDir, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "main", defaultModel: "bench-task", retry: { enabled: false }, compaction: { enabled: false } }));
}

function manifest(cwd) {
	const result = {};
	for (const name of readdirSync(cwd, { recursive: true })) {
		const path = join(cwd, String(name));
		if (statSync(path).isFile()) result[String(name)] = createHash("sha256").update(readFileSync(path)).digest("hex");
	}
	return result;
}

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		ws.on("message", raw => {
			const message = JSON.parse(raw.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "snapshot_delta" && this.state && message.baseRev === this.state.rev) this.state = { ...this.state, ...message.state, messages: [...this.state.messages, ...message.appended] };
		});
	}
	send(message) { this.ws.send(JSON.stringify(message)); }
	async waitFor(predicate, waitMs = timeoutMs) {
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			const value = predicate(this.state, this.received);
			if (value) return value;
			await sleep(20);
		}
		throw new Error(`benchmark client timeout: ${JSON.stringify({ state: this.state && { isStreaming: this.state.isStreaming, error: this.state.errorMessage }, notices: this.received.filter(message => message.type === "notice").slice(-3) })}`);
	}
}

async function runScenario(taskId, round) {
	const cwd = join(base, `${taskId}-${round}`);
	const dataDir = join(base, `data-${taskId}-${round}`);
	const traceOut = join(base, `trace-${taskId}-${round}.json`);
	mkdirSync(cwd, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, "design-first.json"), JSON.stringify({ enabled: false }));
	const marker = `[PI_BENCH_${taskId.toUpperCase()}]`;
	const prompt = taskDefinitions[taskId].prompt(cwd);
	if (taskId === "read") writeFileSync(join(cwd, "input.txt"), "PI_READ_OK_7F3A\n");
	const before = manifest(cwd);
	const server = await startIsolatedHarness({ env: {
		PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: mockMode ? mockAgentDir : (args["agent-dir"] ? resolve(args["agent-dir"]) : join(homedir(), ".pi", "agent")),
		PI_WEB_NO_BROWSER: "1", PI_TASK_TIMINGS: "1", PI_TASK_TIMINGS_OUT: traceOut,
	} });
	const clientId = `agent-task-${taskId}-${round}`;
	let ws;
	const failures = [];
	let timedOut = false;
	let toolListHash = null;
	try {
		ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
		await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
		const client = new Client(ws);
		client.send({ type: "hello", clientId, protocolVersion: PROTOCOL_VERSION });
		await client.waitFor(state => state?.sessionId);
		client.send({ type: "set_model", modelId: modelArg });
		await client.waitFor(state => `${state?.model?.provider}/${state?.model?.id}` === modelArg);
		if (args.thinking) {
			client.send({ type: "set_thinking", level: args.thinking });
			await client.waitFor(state => state?.thinkingLevel === args.thinking);
		}
		client.send({ type: "set_run_settings", conversationId: client.state.conversationId, autoCompaction: false, autoRetry: false });
		await client.waitFor(state => state?.runSettings?.autoCompaction === false && state?.runSettings?.autoRetry === false);
		toolListHash = createHash("sha256").update(JSON.stringify([...(client.state.tools ?? [])].sort())).digest("hex");
		client.send({ type: "prompt", requestId: "benchmark-host-request", text: prompt });
		try {
			await client.waitFor((state, received) => {
				if (!received.some(message => message.type === "prompt_result" && message.requestId === "benchmark-host-request" && message.ok) || !state || state.isStreaming) return false;
				const userIndex = state.messages.findIndex(message => message.role === "user" && textOf(message.content).includes(marker));
				return userIndex >= 0 && state.messages.slice(userIndex + 1).some(message => message.role === "assistant" && ["stop", "toolUse", "length", "error", "aborted"].includes(message.stopReason));
			});
		} catch (error) {
			timedOut = true;
			failures.push(error.message);
			client.send({ type: "abort" });
			await sleep(100);
		}
		const state = client.state;
		const messages = state?.messages ?? [];
		const userIndex = messages.findIndex(message => message.role === "user" && textOf(message.content).includes(marker));
		const turn = userIndex >= 0 ? messages.slice(userIndex + 1) : [];
		const assistants = turn.filter(message => message.role === "assistant");
		const toolCalls = assistants.flatMap(message => message.content.filter(block => block.type === "toolCall"));
		const toolResults = turn.filter(message => message.role === "toolResult");
		const finalText = assistants.filter(message => !message.content.some(block => block.type === "toolCall")).map(message => textOf(message.content)).join("\n").trim();
		if (timedOut || state?.isStreaming || state?.errorMessage) failures.push("run did not finish cleanly");
		if (state?.queue?.steering?.length || state?.queue?.followUp?.length || state?.recovery?.compaction || state?.recovery?.retry || state?.recovery?.summary || state?.recovery?.branch || state?.runRecovery) failures.push("pending queue or recovery state");
		for (const call of toolCalls) if (!toolResults.some(result => result.toolCallId === call.id)) failures.push(`missing toolResult for ${call.id}`);
		const actualTools = toolCalls.map(call => call.name);
		if (JSON.stringify(actualTools) !== JSON.stringify(taskDefinitions[taskId].tools)) failures.push(`tool sequence ${JSON.stringify(actualTools)}`);
		if (finalText !== taskDefinitions[taskId].canary) failures.push("final answer canary mismatch");
		if (taskId === "bash") {
			const result = toolResults.find(message => message.toolName === "bash");
			if (!result || result.isError || !textOf(result.content).includes(taskDefinitions.bash.canary)) failures.push("bash output/exit assertion failed");
		}
		const after = manifest(cwd);
		const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]);
		if (taskId === "write") {
			if (!existsSync(join(cwd, "result.txt")) || readFileSync(join(cwd, "result.txt"), "utf8") !== "PI_WRITE_OK_4D8B\n") failures.push("write content mismatch");
			if (changed.some(name => name !== "result.txt")) failures.push(`unexpected files changed: ${changed.join(",")}`);
		} else if (changed.length) failures.push(`unexpected files changed: ${changed.join(",")}`);
		return { clientId, toolListHash, actualTools, failures, timedOut };
	} finally {
		ws?.close();
		await server.stop();
		const trace = JSON.parse(readFileSync(traceOut, "utf8"));
		const clientTrace = trace.clients[clientId];
		const sessionTrace = clientTrace ? Object.values(clientTrace.sessions)[0] : null;
		const run = sessionTrace?.runs?.at(-1);
		const host = sessionTrace?.hostRequests?.find(request => request.hostRequestId === "benchmark-host-request");
		if (!run || run.status !== "measured" || run.aborted || !host || host.mappingStatus !== "measured") failures.push("execution trace did not confirm a settled mapped run");
		const executionComplete = !timedOut && failures.every(failure => failure.startsWith("tool sequence") || failure.startsWith("final answer") || failure.startsWith("bash output") || failure.startsWith("write content") || failure.startsWith("unexpected files"));
		const taskCorrect = failures.length === 0;
		const e2e = host?.metrics?.task_e2e_wall_ms?.value ?? null;
		const aggregates = run?.aggregates ?? null;
		const result = {
			task: taskId, round, model: modelArg, executionComplete, taskCorrect, failures,
			toolListHash,
			toolSequence: sessionTrace?.runs?.at(-1)?.tools?.map(tool => tool.toolName) ?? [],
			timing: {
				task_e2e_wall_ms: e2e,
				agent_active_wall_ms: host?.metrics?.agent_active_wall_ms?.value ?? null,
				queue_wait_ms: host?.metrics?.queue_wait_ms?.value ?? null,
				model_wall_union_ms: aggregates?.model_wall_union_ms?.value ?? null,
				tool_wall_union_ms: aggregates?.tool_wall_union_ms?.value ?? null,
				host_wall_union_ms: aggregates?.host_wall_union_ms?.value ?? null,
				host_share: e2e && aggregates?.host_wall_union_ms?.value !== null ? aggregates.host_wall_union_ms.value / e2e : null,
				unclassified_wall_ms: aggregates?.unclassified_wall_ms?.value ?? null,
			},
			coverage: sessionTrace?.coverage ?? null,
			trace: sessionTrace,
		};
		results.push(result);
	}
}

const results = [];
try {
	for (let round = 1; round <= rounds; round++) for (const task of selectedTasks) {
		console.error(`[agent-task] ${task} round ${round}/${rounds} (${mockMode ? "mock" : modelArg})`);
		await runScenario(task, round);
	}
} finally {
	if (mock) await new Promise(resolve => mock.close(resolve));
}

const summarize = values => {
	const finite = values.filter(value => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
	if (!finite.length) return null;
	const quantile = q => finite[Math.min(finite.length - 1, Math.floor((finite.length - 1) * q))];
	return { count: finite.length, p50: quantile(0.5), p95: quantile(0.95), min: finite[0], max: finite.at(-1) };
};
const successful = results.filter(result => result.executionComplete && result.taskCorrect);
const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	mode: mockMode ? "mock" : "real",
	model: modelArg,
	rounds,
	environment: {
		node: process.version,
		commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		gitDiffHead: execFileSync("git", ["diff", "--stat", "HEAD"], { encoding: "utf8" }).trim().split("\n").at(-1),
		sdk: JSON.parse(readFileSync("node_modules/@earendil-works/pi-coding-agent/package.json", "utf8")).version,
	},
	successfulSamples: successful.length,
	results,
	successfulTiming: Object.fromEntries(["task_e2e_wall_ms", "model_wall_union_ms", "tool_wall_union_ms", "host_wall_union_ms", "unclassified_wall_ms"].map(key => [key, summarize(successful.map(result => result.timing[key]))])),
	allExecutionOutcomes: {
		executionComplete: results.filter(result => result.executionComplete).length,
		executionFailed: results.filter(result => !result.executionComplete).length,
		taskIncorrect: results.filter(result => result.executionComplete && !result.taskCorrect).length,
		e2eIncludingFailures: summarize(results.map(result => result.timing.task_e2e_wall_ms)),
	},
};
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
rmSync(base, { recursive: true, force: true });
console.log(JSON.stringify({ out, mode: report.mode, successfulSamples: report.successfulSamples, outcomes: report.allExecutionOutcomes, successfulTiming: report.successfulTiming }, null, 2));
