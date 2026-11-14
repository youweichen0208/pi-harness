/** #145: inspect actual Anthropic-compatible requests through the native SDK. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { withOutputTokenFloor } from "../dist/server/model-output-floor.js";
import { ModelSourceSync } from "../dist/server/model-source-sync.js";
import { listenIsolated } from "./lib/isolated-server.mjs";
const root = mkdtempSync(join(tmpdir(), "pi-length-context-"));
const agent = join(root, "agent"); mkdirSync(agent);
const requests = [];
let signed = false;
const mock = createServer(async (req, res) => {
	let body = ""; for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body); requests.push(payload);
	res.writeHead(200, { "content-type": "text/event-stream" });
	const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event("message_start", { message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
	if (payload.max_tokens > 4096) {
		event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "REPORT_COMPLETE_FIXTURE" } });
		event("content_block_stop", { index: 0 });
		event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5000 } });
		event("message_stop", {}); res.end(); return;
	}
	event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
	event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "UNFINISHED_REASONING_FIXTURE" } });
	if (signed) event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } });
	event("content_block_stop", { index: 0 });
	event("message_delta", { delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 4096 } });
	event("message_stop", {}); res.end();
});
let session, unbind;
try {
	const port = await listenIsolated(mock);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "anthropic-messages", baseUrl: `http://127.0.0.1:${port}`, apiKey: "fixture", models: [{ id: "fixture", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 4096 }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false }, compaction: { enabled: false } }));
	for (signed of [false, true]) {
		({ session } = await createAgentSession({ cwd: root, agentDir: agent, tools: [], sessionManager: SessionManager.inMemory(root) }));
		const before = requests.length;
		await session.prompt("Write a report");
		assert.equal(session.messages.at(-1).stopReason, "length");
		await session.prompt("Continue");
		assert.equal(requests.length, before + 2);
		const next = requests.at(-1);
		assert(next.messages.some(m => m.role === "assistant" && JSON.stringify(m.content).includes("UNFINISHED_REASONING_FIXTURE")), "same-model truncated thinking is included in the next request");
		assert.equal(next.max_tokens, requests[before].max_tokens, "ordinary continue does not raise output budget");
		assert.equal(session.messages.at(-1).stopReason, "length", "the same budget can hit the limit again despite replayed context");
		console.log(`PASS ${signed ? "signed" : "unsigned"}: thinking replayed; ordinary continue retains max_tokens=${next.max_tokens}`);
		session.dispose(); session = undefined;
	}
	// Native models.json uses the same floor without modifying the source file.
	const nativeRuntime = withOutputTokenFloor(await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: join(agent, "models.json"), allowModelNetwork: false }));
	assert.equal(nativeRuntime.getModel("fixture", "fixture").maxTokens, 128000);
	({ session } = await createAgentSession({ cwd: root, agentDir: agent, modelRuntime: nativeRuntime, tools: [], sessionManager: SessionManager.inMemory(root) }));
	await session.prompt("Write report with native model");
	assert.equal(requests.at(-1).max_tokens, 128000);
	assert.equal(session.messages.at(-1).stopReason, "stop");
	await nativeRuntime.refresh({ allowNetwork: false });
	await session.prompt("Write again after reload");
	assert.equal(requests.at(-1).max_tokens, 128000);
	assert.equal(JSON.parse(readFileSync(join(agent, "models.json"), "utf8")).providers.fixture.models[0].maxTokens, 4096);
	console.log("PASS native configured model: default 128000 on wire and after reload, source unchanged");
	session.dispose(); session = undefined;
	// Synced model override keeps identity/history while changing actual request budget.
	const external = join(root, "external"); mkdirSync(external);
	const source = join(external, "opencode.json");
	writeFileSync(source, JSON.stringify({ provider: { gateway: { npm: "@ai-sdk/anthropic", options: { baseURL: `http://127.0.0.1:${port}`, apiKey: "fixture" }, models: { fixture: { reasoning: true, limit: { context: 200000, output: 4096 } } } } } }));
	const env = { OPENCODE_CONFIG: source, PI_MAX_TOKENS_FLOOR: "0" };
	const isolatedAgent = join(root, "synced-agent"); mkdirSync(isolatedAgent);
	writeFileSync(join(isolatedAgent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
	const runtime = await ModelRuntime.create({ authPath: join(isolatedAgent, "auth.json"), modelsPath: join(isolatedAgent, "models.json"), allowModelNetwork: false });
	const sync = new ModelSourceSync(join(root, "data"), isolatedAgent, { home: root, env });
	unbind = await sync.bind(runtime, () => session?.isStreaming ?? false, () => {});
	const provider = sync.configs()[0].providerId;
	({ session } = await createAgentSession({ cwd: root, agentDir: isolatedAgent, modelRuntime: runtime, model: runtime.getModel(provider, "fixture"), tools: [], sessionManager: SessionManager.inMemory(root) }));
	await session.prompt("Write report with synced model");
	assert.equal(requests.at(-1).max_tokens, 4096);
	assert.equal(session.messages.at(-1).stopReason, "length");
	delete env.PI_MAX_TOKENS_FLOOR; await sync.sync();
	assert.equal(sync.configs()[0].models[0].maxTokens, 128000);
	await session.setModel(runtime.getModel(provider, "fixture"));
	await session.prompt("Finish the report after increasing the output budget");
	assert.equal(requests.at(-1).max_tokens, 128000);
	assert(requests.at(-1).messages.some(m => m.role === "assistant" && JSON.stringify(m.content).includes("UNFINISHED_REASONING_FIXTURE")));
	assert.equal(session.messages.at(-1).stopReason, "stop");
	assert(session.messages.at(-1).content.some(b => b.text === "REPORT_COMPLETE_FIXTURE"));
	await runtime.complete(runtime.getModel(provider, "fixture"), { messages: [{ role: "user", content: "Explicit small budget", timestamp: Date.now() }] }, { maxTokens: 1 });
	assert.equal(requests.at(-1).max_tokens, 1, "metadata floor does not overwrite explicit call budgets");
	const localConfig = sync.configs()[0];
	await sync.edit(provider, { ...localConfig, models: [{ ...localConfig.models[0], maxTokens: 180000 }] });
	await session.setModel(runtime.getModel(provider, "fixture"));
	await session.prompt("Write with an independent model");
	assert.equal(requests.at(-1).max_tokens, 128000);
	console.log("PASS independent model: default 128000 on wire");
	console.log("PASS default synced floor: 4096 → 128000 on wire, preserved history, explicit maxTokens=1 unchanged");
} finally {
	session?.dispose(); unbind?.(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
