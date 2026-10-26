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
		const source = JSON.parse(system.match(/Your only source is (\{.+?\})\. Use/)?.[1] ?? "null");
		assert(source && roots.includes(source.root), "child can only open target Workspace repositories or the configured knowledge library");
		record.source = source.root;
		assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ["source_list", "source_read", "source_report", "source_search"]);
		assert.equal(body.reasoning_effort, "high", "children inherit the parent thinking level");
		const requestText = JSON.stringify(body);
		for (const forbidden of ["PARENT_HISTORY_ONLY", "AMBIENT_CONTEXT_ONLY", "AMBIENT_APPEND_ONLY", "ambient_fixture_tool"]) assert(!requestText.includes(forbidden), `fresh child excludes ${forbidden}`);
		for (const sibling of [...expectedRoots, other].filter(path => path !== source.root)) assert(!requestText.includes(`EVIDENCE_${basename(sibling)}`), "children do not inherit sibling evidence");
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
	assert.match(subagentTool.function.description, /without naming repositories or requesting subagents/, "the native model receives natural-question delegation instructions");
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
	assert.equal(output.results.length, rootsFor(scenario).length);
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

	const workspace = await connect("subagents-workspace"); await sendPrompt(workspace, "workspace");
	const all = await finished(workspace, "workspace");
	assert.deepEqual(all.map(result => result.root).sort(), [...expectedRoots, archive].sort());
	assert.equal(new Set(all.map(result => result.sourceId)).size, 4);
	assert.deepEqual(seenResults.get("workspace").remainingSourceIds, []);
	assert.equal(requests.filter(request => request.scenario === "workspace" && request.isChild).length, 12, "five duplicate tasks become one child; all other sources are still covered");
	console.log("PASS issue #135: default workspace run merges same-repository tasks and covers every repository plus knowledge exactly once");

	const direct = await connect("subagents-direct"); await sendPrompt(direct, "direct");
	await wait(() => !direct.state.isStreaming && direct.state.messages.some(message => message.role === "assistant" && text(message.content).includes("幂等指")), "direct answer settles");
	assert.equal(requests.filter(request => request.scenario === "direct").length, 1, "direct answers do not trigger extra host model calls");
	assert(!direct.state.messages.some(message => message.role === "toolResult" && message.toolName === "subagent"), "the host does not force delegation when the model answers directly");
	console.log("PASS subagents: automatic research policy reaches the native model; direct answers make no extra model requests");

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
		// Prepare only model/session state through the real protocol; the research prompt
		// and Workspace identity below must originate in ChatInput/useChat.
		const clientId = "subagents-browser";
		await connect(clientId);
		const { chromium } = await import("playwright-core"), { CHROME_PATH } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath(), headless: true });
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await context.addInitScript(({ clientId, browserWorkspaceId }) => {
			sessionStorage.setItem("pi-web-client-id", clientId);
			localStorage.setItem("pi-harness:project-workspace", browserWorkspaceId);
			localStorage.setItem("pi-harness:lang", "en");
			// Delay only the catalog, not session readiness: sending during this
			// window must retain the selection captured from this browser window.
			const NativeWebSocket = window.WebSocket, heldCatalogs = [];
			let released = false;
			window.__heldCatalogCount = 0;
			window.WebSocket = class extends NativeWebSocket {
				constructor(...args) {
					super(...args);
					this.addEventListener("message", event => {
						if (!released && JSON.parse(event.data).type === "project_workspaces") {
							event.stopImmediatePropagation(); heldCatalogs.push([this, event.data]); window.__heldCatalogCount++;
						}
					});
				}
			};
			window.__releaseWorkspaceCatalog = () => {
				released = true;
				for (const [socket, data] of heldCatalogs.splice(0)) socket.dispatchEvent(new MessageEvent("message", { data }));
			};
		}, { clientId, browserWorkspaceId });
		const page = await context.newPage(), errors = [], sent = [], received = [];
		page.setDefaultTimeout(15000);
		page.on("pageerror", error => errors.push(error.message));
		page.on("websocket", socket => {
			socket.on("framesent", ({ payload }) => { sent.push(JSON.parse(String(payload))); });
			socket.on("framereceived", ({ payload }) => { received.push(JSON.parse(String(payload))); });
		});
		await page.goto(`http://127.0.0.1:${port}`);
		const input = page.locator(".inputbar textarea");
		await input.waitFor();
		await page.waitForFunction(() => window.__heldCatalogCount > 0 && !document.querySelector(".inputbar textarea")?.disabled);
		await input.fill(naturalQuestions.browser);
		await input.press("Enter");
		const prompt = await wait(() => sent.find(message => message.type === "prompt" && message.text === naturalQuestions.browser), "browser-generated prompt");
		assert.equal(prompt.target?.workspaceId, browserWorkspaceId, "ChatInput preserves the captured Workspace even before the catalog arrives");
		assert.equal(prompt.target.cwd, repoA);
		assert.equal(prompt.target.conversationId.length > 0, true);
		await page.evaluate(() => window.__releaseWorkspaceCatalog());
		await page.waitForFunction(() => document.querySelector(".compact-workspace-trigger > span")?.textContent === "Unrelated");
		await wait(() => gates.get("browser")?.length === 3, "browser child progress");
		const cards = page.locator(".toolcall-generic").filter({ has: page.locator('.toolcall-name[title="subagent"]') });
		await cards.last().waitFor();
		const runningCard = cards.last();
		if (await runningCard.locator('.toolcall-name[aria-expanded="false"]').count()) await runningCard.locator(".toolcall-name").click();
		await runningCard.locator('.subagent-view[data-final="false"]').waitFor();
		assert.equal(await runningCard.locator(".subagent-source").count(), 3);
		assert.equal(await runningCard.locator(".subagent-source-task").filter({ hasText: "CASE:browser Investigate evidence.md and cite the business interface." }).count(), 3);
		for (const source of ["repo-a", "other-repo", "knowledge"]) await runningCard.locator(".subagent-source-head strong", { hasText: source }).waitFor();
		assert.match(await runningCard.locator(".toolcall-status").innerText(), /0\/3 subagents finished/);
		assert(received.some(message => message.type === "tool_delta" && message.toolName === "subagent" && message.subagents?.length === 3), "browser receives structured per-source progress");
		mkdirSync("tests/scratch", { recursive: true });
		const pet = page.locator('.trailing-working .agent-expression[data-pose="running"]').last();
		await pet.scrollIntoViewIfNeeded();
		await page.waitForFunction(() => [...document.querySelectorAll('.agent-expression[data-pose="running"]')].some(el => el.getAttribute('data-animate') === 'true'));
		assert.equal(await pet.evaluate(el => getComputedStyle(el, '::before').animationName), 'agent-expression-eyes');
		assert.equal(await page.locator('.msg-assistant .msg-role').first().evaluate(el => getComputedStyle(el, '::before').display), 'none', "pet replaces the reply icon without duplication");
		const positions = new Set();
		for (let i = 0; i < 5; i++) { positions.add(await pet.evaluate(el => getComputedStyle(el, '::before').backgroundPositionX)); await sleep(150); }
		assert(positions.size > 1, "the sprite actually advances frames");
		await page.emulateMedia({ reducedMotion: 'reduce' });
		assert.equal(await pet.evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await pet.screenshot({ path: "tests/scratch/grass-cow-running.png" });
		await runningCard.screenshot({ path: "tests/scratch/subagents-running.png" });
		for (const item of gates.get("browser")) item.sendRead();
		await wait(() => seenResults.has("browser"), "browser final results");
		await page.getByText(/SYNTHESIS browser:/).last().waitFor();
		await page.waitForFunction(() => !document.querySelector('.trailing-working .agent-expression'));
		const reports = seenResults.get("browser").results;
		assert.deepEqual(reports.map(result => result.root).sort(), rootsFor("browser").sort());
		assert(reports.every(result => result.status === "completed"));
		assert(!reports.some(result => result.root === repoB), "the previously selected Business Workspace does not leak into the browser's Unrelated selection");
		const answer = await page.getByText(/SYNTHESIS browser:/).last().innerText();
		assert.match(answer, /other-repo completed/); assert.match(answer, /knowledge completed/); assert.match(answer, /evidence\.md:2/);
		const progressFrames = received.filter(message => message.type === "tool_delta" && Array.isArray(message.subagents));
		assert(progressFrames.length > 0);
		assert(progressFrames.every(message => !("details" in message) && message.subagents.every(item => Object.keys(item).every(key => ["sourceId", "source", "root", "task", "phase", "tool"].includes(key)))), "wire progress is an allowlisted projection, not native child details");
		const persistedResults = received.flatMap(message => message.type === "snapshot" ? message.state.messages : message.type === "snapshot_delta" ? message.appended : []).filter(message => message.role === "toolResult" && message.toolName === "subagent");
		assert(persistedResults.length > 0 && persistedResults.every(message => !message.details || !Object.hasOwn(message.details, "subagents")), "native subagent details never cross the snapshot wire");
		const readFrame = progressFrames.findIndex(message => message.subagents.some(item => item.tool === "source_read"));
		assert(readFrame >= 0, "reading activity reaches the browser");
		const reading = progressFrames[readFrame].subagents.find(item => item.tool === "source_read");
		assert(progressFrames.slice(readFrame + 1).some(message => message.subagents.some(item => item.sourceId === reading.sourceId && item.phase === "running" && !item.tool)), "tool_execution_end clears stale reading activity");
		await runningCard.locator('.subagent-view[data-final="true"]').waitFor();
		assert.equal(await page.locator(".toolcall-subagents").count(), 1, "sources and inspect keep the generic JSON tool card");
		assert.match(await runningCard.locator(".toolcall-status").innerText(), /3 source reports/);
		assert.equal(await runningCard.locator(".subagent-workspace").innerText(), "Workspace · Unrelated");
		const heads = runningCard.locator(".subagent-source-head");
		for (let index = 0; index < 3; index++) {
			const head = heads.nth(index);
			if (await head.getAttribute("aria-expanded") === "false") { await head.focus(); await head.press("Enter"); }
			assert.equal(await head.getAttribute("aria-expanded"), "true");
		}
		assert.equal(await runningCard.locator(".subagent-evidence-badge.checked").count(), 3);
		assert.equal(await heads.first().locator(".subagent-activity").innerText(), "Done", "source completion is separate from citation verification");
		assert.equal(await runningCard.locator(".subagent-evidence-note").count(), 3);
		assert.match(await runningCard.locator(".subagent-evidence-note").first().innerText(), /conclusions are not proven/, "citation limits are visible without hovering");
		assert.equal(await runningCard.locator(".subagent-usage").count(), 3);
		assert.match(await runningCard.locator(".subagent-usage").first().innerText(), /Tokens: in \d+ · out \d+/);
		assert.deepEqual((await runningCard.locator(".subagent-source-root code").allTextContents()).sort(), rootsFor("browser").sort());
		assert.equal(await runningCard.locator(`[data-source-id="${reports.find(result => result.root === repoA).sourceId}"] .subagent-finding-kind`).innerText(), "Implementation");
		const knowledge = runningCard.locator(`[data-source-id="${reports.find(result => result.root === library).sourceId}"]`);
		assert.equal(await knowledge.locator(".subagent-finding-kind").innerText(), "Documentation");
		assert.equal(await knowledge.locator(".subagent-summary").innerText(), businessEvidence.get(library));
		const citation = knowledge.locator(".subagent-citation");
		assert.equal(await citation.locator("summary").innerText(), "evidence.md:2");
		await citation.locator("summary").click();
		assert.match(await citation.locator("pre").innerText(), /EVIDENCE_knowledge: The refund policy permits partial refunds tied to orderId\./);
		await heads.first().press("Enter"); assert.equal(await heads.first().getAttribute("aria-expanded"), "false");
		await heads.first().press("Space"); assert.equal(await heads.first().getAttribute("aria-expanded"), "true");
		await runningCard.locator(".subagent-raw > summary").click();
		const raw = await runningCard.locator(".subagent-raw").innerText();
		assert.match(raw, /Raw arguments and output/); assert.match(raw, /"results"/); assert.match(raw, /"action"\s*:\s*"run"/);
		await runningCard.locator(".subagent-raw > summary").click();
		await runningCard.locator(".toolcall-expand").click();
		const reportZoom = page.locator(".toolcall-zoom");
		await reportZoom.locator('.subagent-view[data-final="true"]').waitFor();
		assert.equal(await reportZoom.locator(".subagent-source").count(), 3);
		await page.keyboard.press("Escape"); await reportZoom.waitFor({ state: "detached" });
		await page.emulateMedia({ reducedMotion: "reduce" });
		assert(await runningCard.evaluate(element => [...element.querySelectorAll(".subagent-view, .subagent-source-detail")].every(node => getComputedStyle(node).animationName === "none") && [...element.querySelectorAll(".subagent-chevron")].every(node => getComputedStyle(node).transitionDuration === "0s")), "reduced motion disables progress/report transitions");
		mkdirSync("tests/scratch", { recursive: true });
		const desktopHeight = await runningCard.evaluate(element => Math.ceil(element.getBoundingClientRect().height));
		await page.setViewportSize({ width: 1440, height: desktopHeight + 400 });
		await runningCard.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
		await runningCard.screenshot({ path: "tests/scratch/subagents-report.png" });
		await page.screenshot({ path: "tests/scratch/subagents-chat.png", fullPage: true });
		await page.evaluate(() => { localStorage.setItem("pi-harness:theme", "graphite"); window.dispatchEvent(new StorageEvent("storage", { key: "pi-harness:theme" })); });
		await page.waitForFunction(() => document.documentElement.dataset.appearance === "dark");
		await runningCard.screenshot({ path: "tests/scratch/subagents-report-dark.png" });
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "390px page does not overflow horizontally");
		assert(await runningCard.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "390px report card does not overflow horizontally");
		await page.screenshot({ path: "tests/scratch/subagents-chat-mobile.png" });
		const mobileHeight = await runningCard.evaluate(element => Math.ceil(element.getBoundingClientRect().height));
		await page.setViewportSize({ width: 390, height: mobileHeight + 400 });
		await runningCard.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
		await runningCard.screenshot({ path: "tests/scratch/subagents-report-mobile.png" });
		await page.close();
		// At 200% desktop zoom a 1440px window has a 720 CSS-pixel viewport.
		const zoomContext = await browser.newContext({ viewport: { width: 720, height: 500 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
		await zoomContext.addInitScript(({ clientId, browserWorkspaceId }) => {
			sessionStorage.setItem("pi-web-client-id", clientId);
			localStorage.setItem("pi-harness:project-workspace", browserWorkspaceId);
			localStorage.setItem("pi-harness:lang", "zh");
		}, { clientId, browserWorkspaceId });
		const zoomPage = await zoomContext.newPage(); zoomPage.on("pageerror", error => errors.push(error.message));
		await zoomPage.goto(`http://127.0.0.1:${port}`);
		const zoomCard = zoomPage.locator(".toolcall-subagents").last();
		await zoomCard.waitFor();
		if (await zoomCard.locator('.toolcall-name[aria-expanded="false"]').count()) await zoomCard.locator(".toolcall-name").click();
		await zoomCard.locator('.subagent-view[data-final="true"]').waitFor();
		await zoomCard.getByText("引用已核验", { exact: true }).first().waitFor();
		assert.equal(await zoomCard.locator(".subagent-source").count(), 3);
		assert(await zoomCard.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "200% zoom effective viewport does not overflow");
		const zoomHeight = await zoomCard.evaluate(element => Math.ceil(element.getBoundingClientRect().height));
		await zoomPage.setViewportSize({ width: 720, height: zoomHeight + 400 });
		await zoomCard.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
		await zoomCard.screenshot({ path: "tests/scratch/subagents-report-zoom-2x.png" });
		await zoomPage.setViewportSize({ width: 390, height: 844 });
		await zoomCard.getByText("仅表示引用文本与指纹在提交时通过核验，不证明结论正确。", { exact: true }).waitFor();
		assert(await zoomCard.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "Chinese 390px report does not overflow");
		assert(await zoomPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Chinese 390px page does not overflow");
		const chineseMobileHeight = await zoomCard.evaluate(element => Math.ceil(element.getBoundingClientRect().height));
		await zoomPage.setViewportSize({ width: 390, height: chineseMobileHeight + 400 });
		await zoomCard.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
		await zoomCard.screenshot({ path: "tests/scratch/subagents-report-mobile-zh.png" });
		await zoomContext.close();
		assert.deepEqual(errors, []);
		console.log("PASS subagents browser: Workspace isolation, structured live progress/tool completion, per-source cited reports, keyboard/raw data, Chinese/dark/mobile/200% zoom and reduced motion");
	}
} finally {
	await browser?.close();
	for (const res of held) res.destroy();
	for (const client of clients) client.ws.terminate();
	await harness?.stop();
	model.closeAllConnections(); if (model.listening) await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
