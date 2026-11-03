/** Real WebSocket → AgentService → native extension → SDK children. --browser also sends through ChatInput.
 * The scripted model verifies policy delivery and execution, not real-model intent recognition or source selection.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import WebSocket from "ws";
import { scrubHostEnv } from "./lib/test-env.mjs";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { PROTOCOL_VERSION } from "../dist/server/protocol-version.js";

scrubHostEnv();
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagents-")));
const agentDir = join(root, "agent"), dataDir = join(root, "data");
const repoA = join(root, "repo-a"), repoB = join(root, "repo-b"), other = join(root, "other-repo"), library = join(root, "knowledge");
const archive = join(root, "archive");
const expectedRoots = [repoA, repoB, library];
const workspaceId = "business-workspace";
const browserWorkspaceId = "unrelated-workspace";
const naturalQuestions = { happy: "退款流程是怎样的？", browser: "退款从发起到完成，经过哪些模块？", direct: "什么是幂等？" };
const rootsFor = scenario => scenario === "browser" ? [repoA, other, library] : scenario === "workspace" ? [...expectedRoots, archive] : expectedRoots;
const registeredRootsFor = scenario => scenario === "browser" ? rootsFor(scenario) : [...expectedRoots, archive];
const businessEvidence = new Map([
	[archive, "Historical visual assets; no refund implementation or policy."],
	[repoA, "refundOrder(orderId) calls POST /refund and rejects partial refunds."],
	[repoB, "POST /refund accepts a refund amount and emits RefundCompleted(orderId)."],
	[other, "The refund reconciliation module joins RefundCompleted with orderId."],
	[library, "The refund policy permits partial refunds tied to orderId."],
]);
for (const dir of [agentDir, dataDir, repoA, repoB, other, library, archive, join(agentDir, "extensions")]) mkdirSync(dir, { recursive: true });
for (const dir of [...expectedRoots, other, archive]) {
	writeFileSync(join(dir, "evidence.md"), `# ${basename(dir)}\nEVIDENCE_${basename(dir)}: ${businessEvidence.get(dir)}\n`);
	writeFileSync(join(dir, "README.md"), `# ${basename(dir)}\n${businessEvidence.get(dir)} See evidence.md for this fixture's implementation or policy.\n`);
}
writeFileSync(join(archive, "README.md"), "# Design archive\nHistorical visual assets only. No business implementation or refund policy.\n");
writeFileSync(join(agentDir, "AGENTS.md"), "AMBIENT_CONTEXT_ONLY: parent context fixture.\n");
writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "AMBIENT_APPEND_ONLY: parent context fixture.\n");
writeFileSync(join(agentDir, "extensions", "fixture.ts"), 'import { Type } from "typebox"; export default pi => pi.registerTool({ name: "ambient_fixture_tool", label: "Fixture", description: "Parent fixture only", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "parent only" }], details: {} }) });\n');
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture" } }));
writeFileSync(join(agentDir, "webui-extensions.json"), JSON.stringify({ autoCheck: false }));
writeFileSync(join(dataDir, "plan-settings.json"), JSON.stringify({ enabled: false }));
writeFileSync(join(dataDir, "project-workspaces.json"), JSON.stringify({ revision: 1, workspaces: [
	{ id: workspaceId, name: "Business", paths: [repoA, repoB, archive] },
	{ id: "unrelated-workspace", name: "Unrelated", paths: [repoA, other] },
] }));
writeFileSync(join(dataDir, "knowledge-library.json"), JSON.stringify({ cwd: library, path: null }));

let service, harness, browser, port, logs = "", fixtureError;
const clients = [], requests = [], gates = new Map(), seenSources = new Map(), seenResults = new Map();
const held = new Set(), disconnected = new Set();
let requestNumber = 0;
const text = content => typeof content === "string" ? content : (content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const model = createServer((req, res) => { void handleModel(req, res).catch(error => {
	fixtureError ??= error;
	if (!res.destroyed) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: error.message } })); }
}); });

function respond(res, modelId, content, tool) {
	if (res.destroyed) return;
	const id = `fixture-${++requestNumber}`;
	const delta = tool ? { tool_calls: [{ index: 0, id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { content };
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }]) {
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: modelId, choices: [choice] })}\n\n`);
	}
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: modelId, choices: [], usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 } })}\n\n`);
	res.end("data: [DONE]\n\n");
}

async function handleModel(req, res) {
	let raw = ""; for await (const chunk of req) raw += chunk;
	const body = JSON.parse(raw), messages = body.messages;
	const system = messages.filter(message => ["system", "developer"].includes(message.role)).map(message => text(message.content)).join("\n");
	const isChild = system.includes("focused read-only research subagent");
	const userIndex = messages.findLastIndex(message => message.role === "user");
	const task = text(messages[userIndex]?.content);
	const scenario = task.match(/CASE:(\w+)/)?.[1] ?? Object.entries(naturalQuestions).find(([, question]) => task === question)?.[0] ?? "history";
	const roots = rootsFor(scenario);
	const record = { scenario, isChild, body };
	requests.push(record);
	assert.equal(body.model, "selected", "both parent and children use the UI-selected model, not the default");
	if (isChild) {
		const sourceList = JSON.parse(system.match(/Your selected sources are (\[.+?\])\. Use/)?.[1] ?? "[]");
		const source = sourceList[0];
		assert(source && roots.includes(source.root), "child can only open target Workspace repositories or the configured knowledge library");
		record.source = source.root;
		assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ["source_list", "source_read", "source_report", "source_search"]);
		assert.equal(body.reasoning_effort, "high", "children inherit the parent thinking level");
		const requestText = JSON.stringify(body);
		for (const forbidden of ["PARENT_HISTORY_ONLY", "AMBIENT_CONTEXT_ONLY", "AMBIENT_APPEND_ONLY", "ambient_fixture_tool"]) assert(!requestText.includes(forbidden), `fresh child excludes ${forbidden}`);
		for (const sibling of [...expectedRoots, other].filter(path => !sourceList.some(source => source.root === path))) assert(!requestText.includes(`EVIDENCE_${basename(sibling)}`), "children do not inherit sibling evidence");
		if (["nosteps", "reportonly", "readfailure"].includes(scenario)) {
			const called = messages.some(message => message.role === "tool");
			if (scenario === "nosteps" || called) respond(res, body.model, "Unverified answer without successful investigation");
			else if (scenario === "reportonly") respond(res, body.model, undefined, { name: "source_report", args: { summary: "No investigation", findings: [], connections: [], openQuestions: [] } });
			else respond(res, body.model, undefined, { name: "source_read", args: { path: "missing-file.md" } });
			return;
		}
		if (scenario === "multi" && sourceList.length > 1) {
			const results = messages.filter(message => message.role === "tool");
			if (results.length < 2) respond(res, body.model, undefined, { name: "source_read", args: { sourceId: sourceList[results.length].id, path: "evidence.md", startLine: 2, limit: 1 } });
			else if (results.length === 2) respond(res, body.model, undefined, { name: "source_report", args: { summary: "Compare orderId across repositories", findings: [{ kind: "implementation", statement: "Both sources use orderId", citations: results.map(result => ({ evidenceId: text(result.content).match(/evidenceId (ev_[a-f0-9]+)/)[1], startLine: 2, endLine: 2 })) }], connections: [], openQuestions: [] } });
			else respond(res, body.model, "Compared both repositories using observed source evidence.");
			return;
		}
		const readResult = messages.findLast(message => message.role === "tool");
		if (readResult) {
			const called = messages.flatMap(message => message.tool_calls ?? []).findLast(call => call.id === readResult.tool_call_id)?.function.name;
			if (called === "source_report") {
				const submissions = messages.flatMap(message => message.tool_calls ?? []).filter(call => call.function.name === "source_report");
				if (scenario === "invalid" && submissions.length === 1) {
					assert.match(text(readResult.content), /Report accepted:/);
					respond(res, body.model, undefined, { name: "source_report", args: { summary: "Invalid correction missing required fields" } });
					return;
				}
				respond(res, body.model, `${basename(source.root)}: evidence.md:2 establishes orderId; EVIDENCE_${basename(source.root)}.`);
				return;
			}
			assert.match(text(readResult.content), new RegExp(`evidence\\.md:2: EVIDENCE_${basename(source.root)}`), "real source_read returns line-numbered source text");
			assert.match(text(readResult.content), /SHA-256 [a-f0-9]{64}/);
			if (scenario === "unverified") {
				respond(res, body.model, `${basename(source.root)}: evidence.md:2 is a free-text report without submitted evidence.`);
				return;
			}
			const evidenceId = text(readResult.content).match(/evidenceId (ev_[a-f0-9]+)/)?.[1];
			assert(evidenceId, "source_read exposes a host-issued evidence ID");
			respond(res, body.model, undefined, { name: "source_report", args: {
				summary: businessEvidence.get(source.root),
				findings: [{ kind: source.kind === "knowledge" ? "documentation" : "implementation", statement: businessEvidence.get(source.root), citations: [{ evidenceId, startLine: 2, endLine: 2 }] }],
				connections: ["Check orderId and POST /refund against the other source's evidence."], openQuestions: [],
			} });
			return;
		}
		if (scenario === "failure" && source.root === repoB) {
			res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Fixture repository model failed" } })); return;
		}
		const sendRead = () => respond(res, body.model, undefined, { name: "source_read", args: { path: "evidence.md", startLine: 2, limit: 1 } });
		if (["happy", "cancel", "browser"].includes(scenario)) {
			const group = gates.get(scenario) ?? []; group.push({ source: source.root, res, sendRead }); gates.set(scenario, group);
			assert.equal(new Set(group.map(item => item.source)).size, group.length, "one initial request per source");
			if (scenario === "cancel") {
				held.add(res); res.once("close", () => { held.delete(res); disconnected.add(source.root); });
			} else if (scenario === "happy" && group.length === 3) {
				for (const item of group) item.sendRead();
			}
			return;
		}
		sendRead(); return;
	}
	const subagentTool = body.tools.find(tool => tool.function.name === "subagent");
	assert(subagentTool, "native subagent tool is declared to the parent model");
	assert.match(system, /without naming repositories or requesting subagents/, "the native model receives natural-question delegation instructions");
	assert.match(system, /Before substantial project research, call subagent action=sources/, "the native system prompt includes source discovery guidance");
	assert.match(system, /Respect explicit source restrictions and requests to work without subagents/, "the native system prompt preserves user restrictions");
	if (scenario === "history") { respond(res, body.model, "Parent fixture history recorded."); return; }
	if (scenario === "direct") { respond(res, body.model, "幂等指同一操作重复执行，其效果与执行一次相同。"); return; }
	const outputs = messages.slice(userIndex + 1).filter(message => message.role === "tool");
	if (!outputs.length) { respond(res, body.model, undefined, { name: "subagent", args: { action: "sources" } }); return; }
	const output = JSON.parse(text(outputs.at(-1).content));
	if (output.sources) {
		seenSources.set(scenario, output);
		assert.equal(output.issue, undefined);
		assert.equal(output.workspace.id, scenario === "browser" ? browserWorkspaceId : workspaceId, "prompt.target.workspaceId resolves overlapping membership");
		assert.equal(output.workspaces.length, 2, "fixture has overlapping Workspace membership");
		assert.deepEqual(output.sources.map(source => source.root).sort(), registeredRootsFor(scenario).sort());
		respond(res, body.model, undefined, { name: "subagent", args: { action: "inspect", sourceIds: output.sources.map(source => source.id) } });
		return;
	}
	if (output.inspections) {
		assert.deepEqual(output.inspections.map(source => source.root).sort(), registeredRootsFor(scenario).sort());
		for (const inspection of output.inspections) {
			assert.equal(inspection.status, "completed");
			assert(inspection.excerpts.some(excerpt => excerpt.path === "README.md" && excerpt.text.includes("README.md:2:")), "source inspection gives real line-numbered responsibility evidence");
		}
		// Deterministic selection verifies transport and scope, not model relevance judgment.
		const selected = seenSources.get(scenario).sources.filter(source => roots.includes(source.root));
		if (scenario === "multi") {
			respond(res, body.model, undefined, { name: "subagent", args: { action: "run", tasks: [
				{ title: "Compare repositories", sourceIds: selected.slice(0, 2).map(source => source.id), task: "CASE:multi Compare orderId" },
				{ title: "Review first repository", sourceIds: [selected[0].id], task: "CASE:multi Review orderId" },
			] } });
			return;
		}
		if (scenario === "workspace") {
			respond(res, body.model, undefined, { name: "subagent", args: { action: "run", question: "CASE:workspace Explain the refund flow", tasks: Array.from({ length: 5 }, (_, i) => ({ sourceId: selected[0].id, task: `Investigate aspect ${i}` })) } });
			return;
		}
		respond(res, body.model, undefined, { name: "subagent", args: { action: "run", scope: "selected", tasks: selected.map(source => ({ sourceId: source.id, task: `CASE:${scenario} Investigate evidence.md and cite the business interface.` })) } });
		return;
	}
	assert(Array.isArray(output.results), "parent receives the child result group");
	seenResults.set(scenario, output);
	respond(res, body.model, `SYNTHESIS ${scenario}: ${output.results.map(result => `${result.source} ${result.status}: ${result.text}`).join(" | ")}`);
}

async function wait(check, label, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fixtureError) throw fixtureError;
		if (service?.exitCode != null) throw Error(`Service exited: ${logs.slice(-4000)}`);
		const value = await check(); if (value) return value;
		await sleep(20);
	}
	throw Error(`Timeout: ${label}\n${logs.slice(-4000)}`);
}

async function connect(id) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const client = { ws, state: undefined, wire: [], send: message => ws.send(JSON.stringify(message)) }; clients.push(client);
	ws.on("message", raw => {
		const message = JSON.parse(raw); client.wire.push(message);
		if (message.type === "snapshot") client.state = message.state;
		else if (message.type === "snapshot_delta" && client.state) {
			if (client.state.conversationId !== message.conversationId || client.state.rev !== message.baseRev) client.send({ type: "get_state" });
			else client.state = { ...client.state, ...message.state, messages: [...client.state.messages, ...message.appended] };
		}
	});
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	client.send({ type: "hello", clientId: id, protocolVersion: PROTOCOL_VERSION });
	await wait(() => client.state && !client.state.tree?.verifying, "initial snapshot");
	if (client.state.messages.some(message => message.role === "user")) {
		const previousConversation = client.state.conversationId;
		client.send({ type: "new_chat", fresh: true });
		await wait(() => client.state.conversationId !== previousConversation && !client.state.tree?.verifying, "isolated test conversation");
	}
	client.send({ type: "set_model", modelId: "fixture/selected" });
	await wait(() => client.state.model?.id === "selected", "model selection");
	client.send({ type: "set_thinking", level: "high" });
	await wait(() => client.state.thinkingLevel === "high", "thinking selection");
	return client;
}

async function sendPrompt(client, scenario, promptText = naturalQuestions[scenario] ?? `CASE:${scenario} 退款流程是怎样的？`) {
	const { cwd, conversationId, sessionId } = client.state;
	client.send({ type: "prompt", requestId: `request-${scenario}`, text: promptText, target: { cwd, conversationId, sessionId, workspaceId } });
	const receipt = await wait(() => client.wire.find(message => message.type === "prompt_result" && message.requestId === `request-${scenario}`), "send receipt");
	assert.equal(receipt.ok, true);
}

function resultOnWire(client) {
	return client.state.messages.filter(message => message.role === "toolResult" && message.toolName === "subagent").map(message => {
		try { return JSON.parse(text(message.content)); } catch { return undefined; }
	}).findLast(value => value?.results);
}

async function finished(client, scenario) {
	await wait(() => !client.state.isStreaming && client.state.messages.some(message => message.role === "assistant" && text(message.content).includes(`SYNTHESIS ${scenario}:`)), `${scenario} synthesis and settled snapshot`);
	const output = resultOnWire(client);
	assert(output, "child result JSON crosses the standard tool-result wire format");
	assert.equal(output.workspace.id, workspaceId);
	assert.equal(output.results.length, scenario === "workspace" ? 5 : scenario === "multi" ? 2 : rootsFor(scenario).length);
	assert(client.wire.some(message => message.type === "tool_delta" && message.toolName === "subagent"), "child progress streams through the existing tool card channel");
	assert(client.wire.some(message => message.type === "tool_status" && message.toolName === "subagent" && !message.isError), "group completion reaches the tool status channel");
	return output.results;
}

try {
	await listenIsolated(model);
	const modelConfig = id => ({ id, name: id, input: ["text"], reasoning: true, contextWindow: 64000, maxTokens: 2000, cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 }, compat: { supportsReasoningEffort: true } });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${model.address().port}`, apiKey: "fixture", models: [modelConfig("default"), modelConfig("selected")] } } }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "default", retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: "off" }));
	harness = await startIsolatedHarness({ env: { PI_WEB_TOKEN: "", PI_WEB_CWD: repoA, PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir }, onOutput: value => { logs = (logs + value).slice(-12000); } });
	service = harness.child; port = harness.port;
	const happy = await connect("subagents-happy");
	await sendPrompt(happy, "history", "PARENT_HISTORY_ONLY: retain this private conversation marker.");
	await wait(() => !happy.state.isStreaming && happy.state.messages.some(message => text(message.content).includes("Parent fixture history recorded.")), "parent history");
	await sendPrompt(happy, "happy");
	const good = await finished(happy, "happy");
	assert.equal(gates.get("happy").length, 3, "all three initial child requests arrived before any returned");
	assert.deepEqual(good.map(result => result.root).sort(), [...expectedRoots].sort());
	for (const result of good) {
		assert.equal(result.status, "completed"); assert.match(result.text, /evidence\.md:2/); assert.equal(result.truncated, false);
		assert.equal(result.usage.input, 57); assert.equal(result.usage.output, 21); assert(result.usage.cost > 0); assert(result.durationMs >= 0);
		assert.deepEqual(result.steps.map(step => step.tool), ["source_read", "source_report"]);
		assert(result.steps.every(step => step.status === "completed" && Number.isFinite(step.durationMs) && step.durationMs >= 0));
		assert.equal(result.steps[0].target, "evidence.md");
		assert.equal(result.evidenceStatus, "checked");
		const finding = result.report.findings[0], citation = finding.citations[0];
		assert.equal(finding.kind, result.root === library ? "documentation" : "implementation");
		assert.equal(citation.path, "evidence.md"); assert.equal(citation.startLine, 2); assert.equal(citation.endLine, 2);
		assert.match(citation.sha256, /^[a-f0-9]{64}$/); assert(citation.excerpt.includes(businessEvidence.get(result.root)));
		assert(Number.isFinite(Date.parse(result.report.checkedAt)), "reports state when cited file contents were checked");
	}
	assert.equal(requests.filter(request => request.scenario === "happy" && request.isChild).length, 9, "each child reads, submits a checked report and finishes, with no host-added model calls");
	assert.equal(requests.filter(request => request.scenario === "happy" && !request.isChild).length, 4, "parent only requests sources, inspection, research and synthesis");
	assert(!requests.some(request => request.source === archive), "an inspected but unselected source starts no child model");
	assert.equal(seenResults.get("happy").results.length, 3);
	console.log("PASS subagents: overlapping Workspace scope, repositories plus knowledge, parallel reads, fresh restricted context, selected model/thinking, citations and usage over real WebSocket");

	const multi = await connect("subagents-multi"); await sendPrompt(multi, "multi");
	const compared = await finished(multi, "multi");
	assert(compared.every(result => result.status === "completed"));
	assert.equal(compared[0].sources.length, 2);
	assert.equal(new Set(compared[0].report.findings[0].citations.map(citation => citation.sourceId)).size, 2);
	assert.equal(compared[0].sourceId, compared[1].sourceId);
	assert.notEqual(compared[0].taskId, compared[1].taskId);
	const requestId = "read-multi-record";
	multi.send({ type: "subagent_request", action: "detail", requestId, conversationId: multi.state.conversationId, taskId: compared[0].taskId });
	const record = await wait(() => multi.wire.find(message => message.requestId === requestId && message.type === "subagent_response"), "multi-source persisted record");
	assert.equal(record.error, undefined); assert.equal(record.detail.task.phase, "completed");
	assert(record.detail.events.some(event => event.type === "tool_end" && event.text.includes("EVIDENCE_")));
	happy.send({ type: "subagent_request", action: "stop", requestId: "foreign-task", conversationId: happy.state.conversationId, taskId: compared[0].taskId });
	assert((await wait(() => happy.wire.find(message => message.requestId === "foreign-task"), "foreign task rejected")).error);
	console.log("PASS subagents: multi-source citations, same-source independent identities, persisted output and cross-session rejection");

	const workspace = await connect("subagents-workspace"); await sendPrompt(workspace, "workspace");
	const all = await finished(workspace, "workspace");
	assert.deepEqual(all.map(result => result.root), Array(5).fill(repoA));
	assert.equal(new Set(all.map(result => result.taskId)).size, 5);
	assert.deepEqual(seenResults.get("workspace").remainingSourceIds, []);
	assert.equal(requests.filter(request => request.scenario === "workspace" && request.isChild).length, 15, "five tasks on the same source stay independent");
	console.log("PASS subagents: task-based dispatch preserves same-repository tasks without surveying unrelated sources");

	const direct = await connect("subagents-direct"); await sendPrompt(direct, "direct");
	await wait(() => !direct.state.isStreaming && direct.state.messages.some(message => message.role === "assistant" && text(message.content).includes("幂等指")), "direct answer settles");
	assert.equal(requests.filter(request => request.scenario === "direct").length, 1, "direct answers do not trigger extra host model calls");
	assert(!direct.state.messages.some(message => message.role === "toolResult" && message.toolName === "subagent"), "the host does not force delegation when the model answers directly");
	console.log("PASS subagents: automatic research policy reaches the native model; direct answers make no extra model requests");

	for (const scenario of ["nosteps", "reportonly", "readfailure"]) {
		const client = await connect(`subagents-${scenario}`); await sendPrompt(client, scenario);
		const results = await finished(client, scenario);
		assert(results.every(result => result.status === "failed" && !result.report && result.text.includes("without a successful investigation step") && result.text.includes("Unverified answer")));
		assert.equal(requests.filter(request => request.scenario === scenario && request.isChild).length, scenario === "nosteps" ? 3 : 6, "no automatic retry for missing investigation");
		const saved = client.state.messages.findLast(message => message.role === "toolResult" && message.subagents?.length);
		assert.equal(saved.subagents.length, 3);
		assert(saved.subagents.every(item => item.steps.length === (scenario === "nosteps" ? 0 : 1)));
	}
	console.log("PASS subagents: missing investigation fails with original answer and no automatic retry");

	const unverified = await connect("subagents-unverified"); await sendPrompt(unverified, "unverified");
	const fallback = await finished(unverified, "unverified");
	assert(fallback.every(result => result.status === "completed" && result.evidenceStatus === "unverified" && !result.report && result.evidenceWarning));
	assert.equal(requests.filter(request => request.scenario === "unverified" && request.isChild).length, 6, "missing structured reports do not trigger host retries");
	console.log("PASS subagents: free-text fallback remains explicitly unverified without forced extra model calls");

	const invalid = await connect("subagents-invalid"); await sendPrompt(invalid, "invalid");
	const rejected = await finished(invalid, "invalid");
	assert(rejected.every(result => result.status === "completed" && result.evidenceStatus === "unverified" && !result.report && result.evidenceWarning.includes("native SDK")));
	console.log("PASS subagents: native argument rejection of a later report invalidates earlier accepted evidence");

	const failure = await connect("subagents-failure"); await sendPrompt(failure, "failure");
	const partial = await finished(failure, "failure");
	assert.equal(partial.find(result => result.root === repoB).status, "failed");
	assert.match(partial.find(result => result.root === repoB).text, /Fixture repository model failed/);
	assert.deepEqual(partial.filter(result => result.status === "completed").map(result => result.root).sort(), [repoA, library].sort());
	assert.equal(requests.filter(request => request.scenario === "failure" && request.source === repoB).length, 1, "failed child does not trigger provider or agent retries");
	console.log("PASS subagents: one source failure preserves sibling reports and reaches the parent synthesis");

	const cancelled = await connect("subagents-cancel"); await sendPrompt(cancelled, "cancel");
	await wait(() => gates.get("cancel")?.length === 3 && cancelled.state.isStreaming, "three child requests in flight");
	cancelled.send({ type: "abort" });
	await wait(() => disconnected.size === 3 && !cancelled.state.isStreaming && resultOnWire(cancelled), "parent abort cancels all children and settles");
	assert(resultOnWire(cancelled).results.every(result => result.status === "cancelled"));
	assert.equal(held.size, 0);
	assert(!seenResults.has("cancel"), "cancellation does not initiate a parent synthesis request");
	assert.equal(requests.filter(request => request.scenario === "cancel" && request.isChild).length, 3);
	console.log("PASS subagents: parent abort closes all child model streams and leaves no continuing synthesis");

	// Native prompt performs async auth preflight while still idle. Cancel at that exact boundary.
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const { runSubagent } = await import("../dist/server/subagents/runner.js");
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "review-model-store.json"), allowModelNetwork: false, refreshOnCreate: false });
	const controller = new AbortController(), before = requests.length;
	let reachedPreflight = false;
	runtime.hasConfiguredAuth = () => { reachedPreflight = true; controller.abort(new Error("Cancelled during auth preflight")); return true; };
	const race = await runSubagent({ source: { id: "preflight-fixture", kind: "repository", name: "repo-a", root: repoA }, task: "CASE:preflight read evidence.md" }, { agentDir, model: runtime.getModel("fixture", "selected"), thinkingLevel: "high", modelRuntime: runtime }, controller.signal, () => {});
	assert(reachedPreflight); assert.equal(race.status, "cancelled"); assert.equal(requests.length, before, "preflight cancellation never starts a model request");
	console.log("PASS subagents: cancellation during native prompt preflight is reissued when the run starts");

	if (process.argv.includes("--browser")) {
		const clientId = "subagents-browser";
		await connect(clientId);
		const { chromium } = await import("playwright-core"), { CHROME_PATH } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath(), headless: true });
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await context.addInitScript(({ clientId, browserWorkspaceId }) => {
			sessionStorage.setItem("pi-web-client-id", clientId);
			localStorage.setItem("pi-harness:project-workspace", browserWorkspaceId);
			localStorage.setItem("pi-harness:lang", "en");
		}, { clientId, browserWorkspaceId });
		const page = await context.newPage(), errors = [], sent = [], received = [];
		page.on("pageerror", error => errors.push(error.message));
		page.on("websocket", socket => { socket.on("framesent", ({ payload }) => sent.push(JSON.parse(String(payload)))); socket.on("framereceived", ({ payload }) => { const message = JSON.parse(String(payload)); if (message.type === "subagent_response") received.push(message); }); });
		await page.goto(`http://127.0.0.1:${port}`);
		const input = page.locator(".inputbar textarea");
		await page.waitForFunction(() => !document.querySelector(".inputbar textarea")?.disabled);
		await input.fill(naturalQuestions.browser); await input.press("Enter");
		await wait(() => gates.get("browser")?.length === 3, "three browser tasks");
		await page.locator(".subagent-task-row").nth(2).waitFor();
		assert.equal(await page.locator(".subagent-task-group").count(), 1);
		const prompt = sent.find(message => message.type === "prompt" && message.text === naturalQuestions.browser);
		assert.equal(prompt.target.workspaceId, browserWorkspaceId);
		await page.reload();
		await page.locator(".subagent-task-row").nth(2).waitFor();
		await page.locator(".subagent-task-row").first().click();
		await page.locator(".subagent-drawer").waitFor();
		await page.locator(".subagent-drawer").getByRole("button", { name: "Stop task", exact: true }).click();
		await wait(() => sent.some(message => message.type === "subagent_request" && message.action === "stop"), "single task stop");
		await page.locator(".subagent-drawer .subagent-task-status.cancelled").waitFor({ timeout: 10000 }).catch(error => { throw Error(`${error}\n${JSON.stringify(received.slice(-3))}`); });
		await page.keyboard.press("Escape");
		for (const item of gates.get("browser").filter(item => item.source !== repoA)) item.sendRead();
		await wait(() => seenResults.has("browser"), "sibling tasks complete");
		await page.getByText(/SYNTHESIS browser:/).last().waitFor();
		const reports = seenResults.get("browser").results;
		assert.equal(reports.filter(result => result.status === "cancelled").length, 1);
		assert.equal(reports.filter(result => result.status === "completed").length, 2);
		await page.reload();
		await page.locator(".subagent-task-group-head").waitFor();
		assert.equal(await page.locator(".subagent-task-group-head").getAttribute("aria-expanded"), "true");
		assert.equal(await page.locator(".subagent-task-row").count(), 2);
		await page.locator(".subagent-task-row").first().click();
		await page.getByRole("button", { name: "Execution", exact: true }).click();
		await page.locator(".subagent-task-timeline li").nth(1).waitFor();
		await page.locator(".subagent-task-timeline li").first().getByText("Output", { exact: true }).click();
		assert.match(await page.locator(".subagent-task-timeline").innerText(), /EVIDENCE_/);
		mkdirSync("tests/scratch", { recursive: true });
		await page.screenshot({ path: "tests/scratch/subagent-task-drawer-desktop.png" });
		await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
		await page.screenshot({ path: "tests/scratch/subagent-task-drawer-zoom.png" });
		await page.evaluate(() => { document.documentElement.style.zoom = ""; });
		await page.evaluate(() => document.documentElement.setAttribute("data-appearance", "dark"));
		await page.screenshot({ path: "tests/scratch/subagent-task-drawer-dark.png" });
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
		await page.screenshot({ path: "tests/scratch/subagent-task-drawer-mobile.png" });
		await page.getByRole("button", { name: "Result", exact: true }).click();
		await page.locator(".subagent-task-result li").first().waitFor();
		assert.match(await page.locator(".subagent-task-result").innerText(), /orderId/);
		await page.keyboard.press("Escape");
		await page.locator(".subagent-task-failures > button").click();
		await page.locator(".subagent-task-failures .subagent-task-row").click();
		await page.getByRole("button", { name: /Prepare retry/i }).click();
		await page.keyboard.press("Escape");
		assert.match(await input.inputValue(), /sourceIds/);
		assert.deepEqual(errors, []);
		console.log("PASS subagents browser: live reload, independent stop, persisted process/output/results, failure retry, dark/mobile and keyboard drawer");
	}

} finally {
	await browser?.close();
	for (const res of held) res.destroy();
	for (const client of clients) client.ws.terminate();
	await harness?.stop();
	model.closeAllConnections(); if (model.listening) await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
