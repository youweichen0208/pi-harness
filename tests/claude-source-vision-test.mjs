/** #165: an image survives Claude Code discovery, runtime sync and the actual SDK request. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelSourceSync } from "../dist/server/model-source-sync.js";
import { listenIsolated } from "./lib/isolated-server.mjs";
const home = mkdtempSync(join(tmpdir(), "claude-vision-"));
const requests = [];
const mock = createServer(async (req, res) => {
	let body = ""; for await (const chunk of req) body += chunk;
	requests.push(JSON.parse(body));
	res.writeHead(200, { "content-type": "text/event-stream" });
	const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event("message_start", { message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
	event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Image received" } });
	event("content_block_stop", { index: 0 });
	event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
	event("message_stop", {}); res.end();
});
let unbind;
try {
	const port = await listenIsolated(mock);
	mkdirSync(join(home, ".claude"));
	const source = join(home, ".claude/settings.json");
	const modelId = "codeagent/maas-glm-5.3-volcengine-codeagent";
	writeFileSync(source, JSON.stringify({ model: `${modelId}[1m]`, env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: "fixture" } }));
	const original = readFileSync(source, "utf8"), agent = join(home, "agent");
	const runtime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: join(agent, "models.json"), allowModelNetwork: false });
	const sync = new ModelSourceSync(join(home, "data"), agent, { home, env: {} });
	unbind = await sync.bind(runtime, () => false, () => {});
	const config = sync.configs()[0], model = runtime.getModel(config.providerId, modelId);
	assert.deepEqual(model.input, ["text", "image"]);
	const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
	const result = await runtime.complete(model, { messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "Read the image" }, { type: "image", mimeType: "image/png", data }] }] });
	assert.equal(result.stopReason, "stop");
	assert.equal(requests[0].model, modelId);
	const image = requests[0].messages.flatMap(message => message.content).find(block => block.type === "image");
	assert.deepEqual(image.source, { type: "base64", media_type: "image/png", data });
	await sync.edit(config.providerId, { ...config, models: [{ ...config.models[0], input: ["text"] }] });
	await sync.sync();
	assert.deepEqual(runtime.getModel(config.providerId, modelId).input, ["text"]);
	assert.equal(readFileSync(source, "utf8"), original);
	console.log("PASS Claude image capability, SDK image payload, clean model ID, persistent text-only override and read-only source");
} finally {
	unbind?.(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	rmSync(home, { recursive: true, force: true });
}
