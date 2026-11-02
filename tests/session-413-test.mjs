// Issue #139: real SDK 413 rejection must not lock sending or edit/resend.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";
import { testEnv } from "./lib/test-env.mjs";
const PORT = Number(process.env.PI_TEST_PORT || 9454), MOCK = PORT + 1;
assert(PORT >= 8900);
for (const port of [PORT, MOCK]) assert.equal(await portUp(port), false, `port ${port} occupied`);
const root = mkdtempSync(join(tmpdir(), "pi-tree-test-")), cwd = join(root, "work"), agent = join(root, "agent");
mkdirSync(cwd); mkdirSync(join(agent, "extensions"), { recursive: true });
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${MOCK}/v1`, apiKey: "unused", models: [{ id: "tree", reasoning: true, contextWindow: 1000000, maxTokens: 1024, input: ["text"] }] } } }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "unused" } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "tree", retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } }));
let failRequest = true;
let replyCount = 0;
const mock = createServer(async (req, res) => {
	let body = ""; for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body);
	if (failRequest) { res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({error:{message:"Request URI/Entity Too Large " + "gateway diagnostic ".repeat(16000)}})); return; }
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "tree-response", object: "chat.completion.chunk", created: Date.now(), model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
	res.write(chunk({ content: `fixture answer ${++replyCount}` }));
	res.write(chunk({}, "stop")); res.end("data: [DONE]\n\n");
});
await new Promise(resolve => mock.listen(MOCK, "127.0.0.1", resolve));
const server = spawn(process.execPath, ["dist/server/index.js"], { env: { ...testEnv(), PORT: String(PORT), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", ws, state;
server.stdout.on("data", d => logs += d); server.stderr.on("data", d => logs += d);
const wire = [];
async function wait(predicate, timeout = 15000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) { const result = await predicate(); if (result) return result; await sleep(20); }
	throw new Error(`Timeout: ${predicate}\n${logs.slice(-2000)}\n${JSON.stringify({tree: state?.tree, messages:state?.messages?.map(m=>({role:m.role,errorMessage:m.errorMessage})), wire:wire.filter(m=>["error","prompt_result"].includes(m.type))})}`);
}
function send(message) { ws.send(JSON.stringify(message)); }
async function connect() {
	ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	ws.on("message", raw => { const m = JSON.parse(raw); wire.push(m); if (m.type === "snapshot") state = m.state; if (m.type === "snapshot_delta" && state) state = { ...state, ...m.state, messages: [...state.messages, ...m.appended] }; });
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	send({ type: "hello", clientId: "tree-test", protocolVersion: 49 }); send({ type: "get_state" });
	await wait(() => state);
}
async function prompt(text) {
	await wait(() => !state.tree?.verifying);
	const count = state.messages.length;
	send({ type: "prompt", text });
	await wait(() => state.messages.length > count && state.messages.at(-1)?.role === "assistant" && !state.isStreaming && !state.tree?.verifying);
}
try {
	await wait(() => portUp(PORT)); await connect();
	await prompt("request rejected with 413");
	assert.equal(state.tree.externallyModified, false, "413 must not mark our own session as externally modified");
	failRequest = false;
	await prompt("send after 413");
	assert.equal(state.tree.externallyModified, false);
	const original = state.messages.find(m => m.role === "user");
	send({ type: "edit_message", conversationId: state.conversationId, messageId: original.id, entryId: original.entryId, text: "edited after 413" });
	await wait(() => state.messages.some(m => m.role === "user" && m.content.some(b => b.text === "edited after 413")) && !state.isStreaming && !state.tree?.verifying);
	assert.equal(state.tree.externallyModified, false);
	console.log("PASS 413 keeps session writable for next prompt and edit/resend");
} finally {
	ws?.close(); server.kill("SIGTERM");
	await new Promise(resolve => server.exitCode !== null ? resolve() : server.once("exit", resolve));
	mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
