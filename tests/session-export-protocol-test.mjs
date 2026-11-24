import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { scrubHostEnv } from "./lib/test-env.mjs";

scrubHostEnv();
const { PROTOCOL_VERSION } = await import("../dist/server/protocol-version.js");
const root = mkdtempSync(join(tmpdir(), "pi-session-export-protocol-"));
const cwd = join(root, "work"), data = join(root, "data"), agent = join(root, "agent");
for (const directory of [cwd, data, agent]) mkdirSync(directory, { recursive: true });
let modelRequests = 0;
const model = createServer((req, res) => {
	void (async () => {
		let raw = ""; for await (const chunk of req) raw += chunk;
		JSON.parse(raw); modelRequests++;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ id: "export", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "EXPORT_DONE" }, finish_reason: null }] })}\n\n`);
		res.end(`data: ${JSON.stringify({ id: "export", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
	})().catch(error => res.destroy(error));
});
const modelPort = await listenIsolated(model);
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "fixture", models: [{ id: "fixture", input: ["text"], contextWindow: 100000, maxTokens: 4096 }] } } }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
const harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent } });
const sockets = [];
async function client(id) {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`); sockets.push(ws);
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	const messages = [];
	ws.on("message", raw => messages.push(JSON.parse(raw.toString())));
	const send = message => ws.send(JSON.stringify(message));
	const waitFor = async (predicate, timeoutMs = 15000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const value = predicate(messages);
			if (value) return value;
			await sleep(20);
		}
		throw new Error(`Export fixture timeout: ${JSON.stringify({ messages: messages.filter(message => ["notice", "prompt_result", "session_export"].includes(message.type)), types: messages.map(message => message.type), lastSnapshot: messages.findLast(message => message.type === "snapshot")?.state, logs: harness.logs })}`);
	};
	send({ type: "hello", clientId: id, protocolVersion: PROTOCOL_VERSION });
	const state = await waitFor(list => list.find(message => message.type === "snapshot" && message.state.sessionId)?.state);
	return { id, ws, send, waitFor, state, messages };
}
function exportUrl(message, overrides = {}) {
	const url = new URL(`http://127.0.0.1:${harness.port}/api/session-export`);
	url.search = new URLSearchParams({ clientId: message.clientId, conversationId: message.conversationId, sessionId: message.sessionId, token: message.token, ...overrides }).toString();
	return url.toString();
}
function remainingFiles() {
	const directory = join(data, "exports");
	return existsSync(directory) ? readdirSync(directory) : [];
}
try {
	const first = await client("export-owner");
	first.send({ type: "prompt", requestId: "export-seed", text: "Produce the export fixture." });
	await first.waitFor(list => list.some(message => message.type === "snapshot" && message.state.messages.some(item => item.role === "assistant") || message.type === "snapshot_delta" && message.appended.some(item => item.role === "assistant")));
	first.send({ type: "prompt", requestId: "export-jsonl", text: "/export jsonl" });
	const event = await first.waitFor(list => list.find(message => message.type === "session_export"));
	const url = exportUrl({ ...event, clientId: first.id });
	const concurrent = await Promise.all([fetch(url), fetch(url)]);
	assert.deepEqual(concurrent.map(response => response.status).sort((a, b) => a - b), [200, 404], "one token allows exactly one concurrent download");
	const success = concurrent.find(response => response.status === 200);
	assert((await success.text()).includes("EXPORT_DONE"));
	assert.equal((await fetch(url)).status, 404, "download token cannot be replayed");
	await sleep(20); assert.deepEqual(remainingFiles(), [], "completed download cleans its temporary file");

	const other = await client("export-other");
	const crossUrl = exportUrl({ ...event, clientId: other.id }, { conversationId: other.state.conversationId, sessionId: other.state.sessionId });
	assert.equal((await fetch(crossUrl)).status, 404, "another client/conversation/session cannot consume the export");

	first.send({ type: "prompt", requestId: "export-cancel", text: "/export jsonl" });
	const cancelled = await first.waitFor(list => list.find(message => message.type === "session_export" && message.token !== event.token));
	const cancelledResponse = await fetch(exportUrl({ ...cancelled, clientId: first.id }));
	assert.equal(cancelledResponse.status, 200);
	await cancelledResponse.body.cancel();
	await sleep(20);
	assert.equal((await fetch(exportUrl({ ...cancelled, clientId: first.id }))).status, 404, "a cancelled download cannot be replayed");
	assert.deepEqual(remainingFiles(), [], "cancelled download closes and cleans its temporary file");

	first.send({ type: "prompt", requestId: "export-before-new", text: "/export jsonl" });
	const beforeNew = await first.waitFor(list => list.find(message => message.type === "session_export" && ![event.token, cancelled.token].includes(message.token)));
	first.send({ type: "prompt", requestId: "export-new", text: "/new" });
	await first.waitFor(list => list.some(message => message.type === "prompt_result" && message.requestId === "export-new" && message.ok));
	const staleUrl = exportUrl({ ...beforeNew, clientId: first.id });
	assert.equal((await fetch(staleUrl)).status, 404, "session replacement invalidates outstanding exports");
	await sleep(20); assert.deepEqual(remainingFiles(), [], "session replacement cleans undownloaded files");
	assert.equal(modelRequests, 1, "export commands and /new never call the model");
	console.log("PASS session export WS/HTTP ownership, concurrent single-use download, replay rejection and replacement cleanup");
} finally {
	for (const socket of sockets) socket.close();
	await harness.stop();
	model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
