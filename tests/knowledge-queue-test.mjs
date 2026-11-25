import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../dist/server/protocol-version.js";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";

// Hold specific provider calls until the test has observed the queue or switched
// conversations. This exercises preflight races without timing the model's reply.
const calls = [], wire = [], holds = new Map();
function hold(marker) { const gate = Promise.withResolvers(); holds.set(marker, gate); return gate; }
const model = createServer(async (req, res) => {
	let body = "";
	for await (const part of req) body += part;
	const request = JSON.parse(body);
	const lastUser = request.messages.findLast(message => message.role === "user");
	const input = JSON.stringify(lastUser?.content);
	const marker = /QUEUE_TEST_[A-Z_]+/.exec(input)?.[0];
	calls.push({ marker, input, request });
	await holds.get(marker)?.promise;
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const choice of [{ index: 0, delta: { content: `Result for ${marker}.` }, finish_reason: null }, { index: 0, delta: {}, finish_reason: "stop" }]) {
		res.write(`data: ${JSON.stringify({ id: "queue", object: "chat.completion.chunk", model: "fixture", choices: [choice] })}\n\n`);
	}
	res.end("data: [DONE]\n\n");
});
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-knowledge-queue-")));
const cwd = join(root, "repo"), agent = join(root, "agent"), data = join(root, "data");
for (const folder of [cwd, agent, data]) mkdirSync(folder);
let harness, ws, state;
const receipts = id => wire.filter(message => message.type === "prompt_result" && message.requestId === id);
async function wait(check, label) {
	for (let i = 0; i < 600; i++) {
		if (check()) return;
		if (harness?.child.exitCode != null) throw new Error(harness.logs);
		await sleep(25);
	}
	throw new Error(`Timed out waiting for ${label}. Provider calls: ${calls.map(c => c.marker)}; notices: ${wire.filter(m => m.type === "notice").map(m => m.text)}\n${harness.logs}`);
}
const send = message => ws.send(JSON.stringify(message));
function prompt(id, command = "", extra = {}) {
	send({ type: "prompt", text: `${command}QUEUE_TEST_${id}`, requestId: id,
		target: { cwd, conversationId: state.conversationId, sessionId: state.sessionId }, ...extra });
}
async function settled(marker) {
	await wait(() => !state.isStreaming && JSON.stringify(state.messages).includes(`Result for QUEUE_TEST_${marker}.`), marker);
}
try {
	const port = await listenIsolated(model);
	writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture" } }));
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}`, apiKey: "fixture",
		models: [{ id: "fixture", input: ["text", "image"], contextWindow: 64000, maxTokens: 8000 }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", steeringMode: "all", followUpMode: "all",
		compaction: { enabled: false }, retry: { enabled: false } }));
	writeFileSync(join(cwd, "note.txt"), "Text for the Learn request.\n");
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent, PI_WEB_TOKEN: "", HOME: root, USERPROFILE: root } });
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	ws.on("message", raw => {
		const message = JSON.parse(raw); wire.push(message);
		if (message.type === "snapshot") state = message.state;
		if (message.type === "snapshot_delta" && state) state = { ...state, ...message.state, messages: [...state.messages, ...(message.appended ?? [])] };
	});
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	send({ type: "hello", clientId: "knowledge-queue", protocolVersion: PROTOCOL_VERSION });
	await wait(() => state && !state.tree?.verifying, "first conversation");
	const firstConversation = state.conversationId;
	const first = hold("QUEUE_TEST_FIRST");
	const textAttachment = { path: "note.txt", mode: "inline", name: "note.txt" };
	prompt("FIRST", "/ask ");
	prompt("SECOND", "/skill:learn ", { attachments: [textAttachment], queue: true });
	prompt("THIRD");
	prompt("FOURTH", "/skill:ask ", { queue: true });
	const batch = ["FIRST", "SECOND", "THIRD", "FOURTH"];
	await wait(() => calls.length && batch.every(id => receipts(id).length), "acceptance of four rapid sends");
	assert.deepEqual(calls.map(c => c.marker), ["QUEUE_TEST_FIRST"]);
	first.resolve();
	await settled("FOURTH");
	assert.deepEqual(calls.map(c => c.marker), batch.map(id => `QUEUE_TEST_${id}`));
	const readTools = ["knowledge_sources", "source_list", "source_read", "source_search"];
	for (const [i, id] of batch.entries()) {
		const tools = calls[i].request.tools.map(t => t.function.name).sort();
		if (id === "THIRD") { assert(tools.includes("write") && tools.includes("bash")); assert(!tools.includes("source_read")); }
		else assert.deepEqual(tools, [...readTools, id === "SECOND" ? "knowledge_write" : "knowledge_investigate"].sort());
		assert.equal(receipts(id).length, 1, `one acknowledgement per accepted send: ${id}`);
		assert.equal(receipts(id)[0].receipt, "accepted");
		assert.equal(receipts(id)[0].conversationId, firstConversation);
		assert.equal(calls[i].input.includes("Text for the Learn request."), id === "SECOND");
	}

	const recallGate = hold("QUEUE_TEST_HOLD_RECALL");
	prompt("HOLD_RECALL", "/ask ");
	await wait(() => calls.at(-1)?.marker === "QUEUE_TEST_HOLD_RECALL", "recall gate");
	const image = { path: "", name: "pixel.png", imageData: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=", mimeType: "image/png" };
	prompt("WITH_TEXT", "/learn ", { attachments: [textAttachment] });
	prompt("WITH_IMAGE", "", { attachments: [image], queue: true });
	await wait(() => receipts("WITH_TEXT").length && receipts("WITH_IMAGE").length, "queued attachments");
	send({ type: "recall_queue", conversationId: firstConversation, requestId: "recall" });
	const recalled = () => wire.find(m => m.type === "queue_recalled" && m.requestId === "recall");
	await wait(recalled, "queue recall");
	assert.equal(recalled().text, "/learn QUEUE_TEST_WITH_TEXT\n\nQUEUE_TEST_WITH_IMAGE");
	assert.deepEqual(recalled().attachments, [textAttachment, image]);
	send({ type: "queue_recall_ack", conversationId: firstConversation, requestId: "recall" });
	recallGate.resolve();
	await settled("HOLD_RECALL");

	const switchGate = hold("QUEUE_TEST_HOLD_SWITCH");
	prompt("HOLD_SWITCH", "/ask ");
	await wait(() => calls.at(-1)?.marker === "QUEUE_TEST_HOLD_SWITCH", "switch gate");
	prompt("ORIGINAL_ONLY", "/learn ");
	await wait(() => receipts("ORIGINAL_ONLY").length, "deferred request");
	send({ type: "new_chat" });
	await wait(() => state.conversationId !== firstConversation && !state.tree?.verifying, "second conversation");
	assert.equal(state.cwd, cwd);
	const secondConversation = state.conversationId;
	prompt("OTHER_CONVERSATION");
	await settled("OTHER_CONVERSATION");
	assert.equal(receipts("OTHER_CONVERSATION")[0].conversationId, secondConversation);
	assert(!JSON.stringify(calls.at(-1).request.messages).includes("QUEUE_TEST_HOLD_SWITCH"));
	const beforeRelease = wire.length;
	switchGate.resolve();
	await wait(() => wire.slice(beforeRelease).some(message => message.type === "conversations" && message.activeId === secondConversation
		&& message.conversations.some(conv => conv.id === firstConversation && !conv.isStreaming)), "first conversation settled while inactive");
	send({ type: "switch_conversation", id: firstConversation });
	await settled("ORIGINAL_ONLY");
	assert.equal(state.conversationId, firstConversation);
	const original = calls.find(c => c.marker === "QUEUE_TEST_ORIGINAL_ONLY");
	assert(!JSON.stringify(original.request.messages).includes("QUEUE_TEST_OTHER_CONVERSATION"));
	assert.deepEqual(original.request.tools.map(t => t.function.name).sort(), [...readTools, "knowledge_write"].sort());
	assert.equal(receipts("ORIGINAL_ONLY").length, 1);
	assert.equal(receipts("ORIGINAL_ONLY")[0].conversationId, firstConversation);
	assert(!calls.some(c => ["QUEUE_TEST_WITH_TEXT", "QUEUE_TEST_WITH_IMAGE"].includes(c.marker)));
	console.log("PASS FIFO independent Knowledge runs, tool declarations, receipts, queued attachments, recall and same-project conversation isolation");
} finally {
	for (const gate of holds.values()) gate.resolve();
	ws?.terminate();
	await harness?.stop();
	model.closeAllConnections();
	await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
