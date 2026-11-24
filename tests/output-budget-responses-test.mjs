import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { withOutputTokenFloor, withReasoningEnabled } from "../dist/server/model-output-floor.js";
import { listenIsolated } from "./lib/isolated-server.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-output-responses-"));
const agent = join(root, "agent"); mkdirSync(agent);
const requests = [];
const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "encrypted-thinking-fixture" };
const mock = createServer(async (req, res) => {
	let raw = ""; for await (const chunk of req) raw += chunk;
	const body = JSON.parse(raw); requests.push(body);
	res.writeHead(200, { "content-type": "text/event-stream" });
	const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	send("response.created", { response: { id: `response-${requests.length}` } });
	if (requests.length === 1) {
		send("response.output_item.added", { output_index: 0, item: reasoning });
		send("response.output_item.done", { output_index: 0, item: reasoning });
		send("response.completed", { response: { id: "response-1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [reasoning], usage: { input_tokens: 20, output_tokens: 4096, total_tokens: 4116 } } });
	} else {
		const item = { type: "message", id: "message-fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "RESPONSE_RECOVERED", annotations: [] }] };
		send("response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
		send("response.output_text.delta", { output_index: 0, content_index: 0, delta: "RESPONSE_RECOVERED" });
		send("response.output_item.done", { output_index: 0, item });
		send("response.completed", { response: { id: "response-2", status: "completed", output: [item], usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 } } });
	}
	res.end();
});
let session;
try {
	const port = await listenIsolated(mock);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-responses", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "fixture", models: [{ id: "fixture", name: "Responses fixture", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 4096 }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "medium", retry: { enabled: false }, compaction: { enabled: false } }));
	const runtime = withReasoningEnabled(withOutputTokenFloor(await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: join(agent, "models.json"), allowModelNetwork: false })));
	({ session } = await createAgentSession({ cwd: root, agentDir: agent, modelRuntime: runtime, tools: [], sessionManager: SessionManager.inMemory(root) }));
	await session.prompt("Reason through the report");
	assert.equal(session.messages.at(-1).stopReason, "length");
	assert.equal(requests[0].max_output_tokens, 4096);
	assert.equal(requests[0].reasoning.effort, "medium");
	await session.prompt("Continue");
	assert.equal(session.messages.at(-1).stopReason, "stop");
	assert.equal(requests.length, 2);
	assert.equal(requests[1].max_output_tokens, 4096);
	assert(requests[1].input.some(item => item.type === "reasoning" && item.encrypted_content === "encrypted-thinking-fixture"), "Responses continuation retains encrypted reasoning");
	console.log("PASS OpenAI Responses: max_output_tokens and encrypted reasoning preserved through native continuation");
} finally {
	session?.dispose(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
