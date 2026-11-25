/** Exercise three native in-memory SDK sessions against a local streaming model. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createKnowledgeInvestigateTool } from "../dist/server/knowledge-investigate.js";
import { resolveWorkspaceScope } from "../dist/server/knowledge-sources.js";
import { PROTOCOL_VERSION } from "../dist/server/protocol-version.js";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { scrubHostEnv } from "./lib/test-env.mjs";

scrubHostEnv();
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-investigation-suite-"))), agent = join(root, "agent");
const paths = [join(root, "api"), join(root, "engine"), join(root, "reference")];
for (const path of [agent, ...paths]) mkdirSync(path);
for (const [i, path] of paths.entries()) {
	writeFileSync(join(path, "answer.ts"), `interface Source${i} {}\n`);
	writeFileSync(join(path, "AGENTS.md"), "PRIVATE_PARENT_INSTRUCTION");
}
const state = { catalog: { revision: 0, workspaces: [{ id: "w", name: "Work", paths }] }, library: { cwd: null, path: null, available: false } };
const scope = resolveWorkspaceScope({ cwd: paths[0] }, state).scope;
const hostContext = { mode: "ask", scope };
const observations = [];
let ready, batchStarts = 0, hanging = 0, closed = 0, seq = 0;
const allStarted = new Promise(resolve => { ready = resolve; });
const fixtureErrors = [];
const call = (name, args) => ({ tool_calls: [{ index: 0, id: `call-${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
function reply(res, delta) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }]) {
		res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "research", choices: [choice] })}\n\n`);
	}
	res.end("data: [DONE]\n\n");
}
let parentCalls = 0;
const model = createServer(async (req, res) => {
	try {
		let raw = "";
		for await (const part of req) raw += part;
		const request = JSON.parse(raw), messages = request.messages;
		const toolReplies = messages.filter(message => message.role === "tool");
		if (request.tools.some(tool => tool.function.name === "knowledge_investigate")) {
			parentCalls++;
			if (!toolReplies.length) {
				const tasks = scope.sources.map((source, index) => ({ sourceIds: [source.id], task: `checkout ${index}` }));
				reply(res, call("knowledge_investigate", { tasks })); return;
			}
			if (toolReplies.length === 1) {
				const result = JSON.parse(toolReplies[0].content);
				assert.deepEqual(result.tasks.map(task => task.status), ["completed", "completed", "completed"]);
				const evidence = result.tasks[1].findings[0].evidence[0];
				reply(res, call("source_read", { sourceId: evidence.sourceId, path: evidence.path, startLine: evidence.startLine, limit: 1 })); return;
			}
			const evidenceId = /evidenceId (ev_[a-f0-9]+)/.exec(toolReplies.at(-1).content)?.[1];
			assert(evidenceId, "parent reread created its own citation");
			reply(res, { content: `[engine/answer.ts:1](#pi-evidence=${evidenceId})` }); return;
		}
		const user = messages.find(message => message.role === "user");
		const job = JSON.parse(typeof user.content === "string" ? user.content : user.content[0].text);
		observations.push(job);
		assert.equal(request.model, "research");
		assert.equal(request.reasoning_effort, "low", "children inherit parent thinking level");
		assert.deepEqual(request.tools.map(tool => tool.function.name).sort(), ["source_list", "source_read", "source_report", "source_search"]);
		assert(!raw.includes("PRIVATE_PARENT_INSTRUCTION"));
		let delta;
		if (job.task === "hang") {
			hanging++;
			res.on("close", () => closed++);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.flushHeaders();
			return;
		}
		if (!toolReplies.length) {
			if (job.task.startsWith("parallel")) {
				if (++batchStarts === 3) ready();
				await allStarted;
			}
			delta = call("source_read", { sourceId: job.sources[0].id, path: "answer.ts", startLine: 1, limit: 1 });
		} else if (toolReplies.length === 1) {
			const id = /evidenceId (ce_[a-f0-9-]+)/.exec(JSON.stringify(toolReplies[0]))?.[1];
			assert(id, "full observed line produced a local ID");
			delta = call("source_report", { findings: [{ finding: "Source interface verified", evidenceIds: [job.task.includes("invalid") ? "invented" : id] }], uncertainties: [] });
		} else delta = { content: "Finished." };
		reply(res, delta);
	} catch (error) {
		fixtureErrors.push(error);
		res.writeHead(400).end("fixture assertion failed");
	}
});

const waitFor = async (check, label) => {
	for (let i = 0; i < 400; i++) {
		if (fixtureErrors.length) throw fixtureErrors[0];
		if (check()) return;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error(`Timeout: ${label}`);
};
let runtime, harness, ws;
try {
	const port = await listenIsolated(model);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
		api: "openai-completions", baseUrl: `http://127.0.0.1:${port}`, apiKey: "local",
		models: [{ id: "research", name: "Research", reasoning: true, input: ["text"], contextWindow: 64000, maxTokens: 8000, compat: { supportsReasoningEffort: true } }],
	} } }));
	writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "local" } }));
	runtime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: join(agent, "models.json"), allowModelNetwork: false });
	const host = {
		sourceState: () => state, getContext: () => hostContext,
		parent: () => ({ model: runtime.getModel("fixture", "research"), thinkingLevel: "low", modelRuntime: runtime, agentDir: agent }),
	};
	const lifetime = new AbortController(), tool = createKnowledgeInvestigateTool(host, () => lifetime.signal);
	const run = (tasks, signal) => tool.execute("test", { tasks }, signal, undefined, {});
	const jobs = scope.sources.map((source, i) => ({ task: i === 1 ? "parallel invalid" : `parallel ${i}`, sourceIds: [source.id] }));
	await assert.rejects(run([...jobs, jobs[0]]), /1–3/);
	await assert.rejects(run([jobs[0], { task: "not registered", sourceIds: ["outside"] }]));
	assert.equal(observations.length, 0);
	const batch = await run(jobs, AbortSignal.timeout(15000));
	if (fixtureErrors.length) throw fixtureErrors[0];
	assert.deepEqual(batch.details.tasks.map(task => task.status), ["completed", "failed", "completed"], JSON.stringify(batch.details));
	assert.match(batch.details.tasks[1].uncertainties[0], /unknown/i);
	for (const index of [0, 2]) {
		const citation = batch.details.tasks[index].findings[0].evidence[0];
		assert.equal(citation.sourceId, jobs[index].sourceIds[0]);
		assert.equal(citation.path, "answer.ts");
		assert.match(citation.sha256, /^[a-f0-9]{64}$/);
	}
	assert(observations.every(job => job.sources.length === 1), "each child received exactly its selected source");
	assert(!existsSync(join(agent, "sessions")), "children did not persist transcripts");
	console.log("PASS real SDK: parallel children, inherited model and thinking, isolated resources, rejection of invented evidence, partial success");

	for (const action of ["stop", "shutdown"]) {
		const controller = new AbortController(), previous = hanging;
		const running = run(jobs.map(job => ({ ...job, task: "hang" })), controller.signal);
		await waitFor(() => hanging === previous + 3, "in-flight child requests");
		await assert.rejects(run(jobs), /running/i);
		(action === "stop" ? controller : lifetime).abort();
		const result = await running;
		assert(result.details.tasks.every(task => task.status === "cancelled"));
		await waitFor(() => closed === hanging, "all child connections closed");
	}
	console.log("PASS parent stop and session shutdown cancel every in-flight child and release batch");

	const data = join(root, "data"), home = join(root, "home");
	mkdirSync(data); mkdirSync(home);
	const catalogFile = join(data, "project-workspaces.json");
	writeFileSync(catalogFile, JSON.stringify(state.catalog));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "research", defaultThinkingLevel: "low" }));
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: paths[0], PI_WEB_DATA_DIR: data, PI_WEB_WORKSPACES_FILE: catalogFile, PI_CODING_AGENT_DIR: agent, PI_WEB_TOKEN: "", HOME: home, USERPROFILE: home } });
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	const wire = [];
	let snapshot;
	ws.on("message", raw => {
		const message = JSON.parse(raw);
		wire.push(message);
		if (message.type === "snapshot") snapshot = message.state;
		if (message.type === "snapshot_delta" && snapshot) snapshot = { ...snapshot, ...message.state };
	});
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	ws.send(JSON.stringify({ type: "hello", clientId: "ask-investigation-suite", protocolVersion: PROTOCOL_VERSION }));
	await waitFor(() => snapshot && !snapshot.tree?.verifying, "Ask session");
	ws.send(JSON.stringify({ type: "prompt", requestId: "cross-repo-ask", text: "/ask Compare the source interfaces" }));
	await waitFor(() => parentCalls >= 3 && wire.some(m => JSON.stringify(m).includes("engine/answer.ts:1](#pi-evidence=ev_")), "parent answer with reread evidence ID");
	console.log("PASS ordinary session /ask: dispatch, verified child reports, parent reread and clickable final citation");
} finally {
	ws?.terminate();
	await harness?.stop();
	model.closeAllConnections();
	await new Promise(resolve => model.close(resolve));
	await runtime?.settleCredentialWrites();
	rmSync(root, { recursive: true, force: true });
}
