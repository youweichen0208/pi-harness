/** Real SDK + HTTP SSE + WebSocket: bounded continuation must retain tool progress. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { SessionManager, getPackageDir } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../dist/server/protocol-version.js";
import { scrubHostEnv } from "./lib/test-env.mjs";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";

scrubHostEnv();
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-run-recovery-")));
const agentDir = join(root, "agent"), cwd = join(root, "workspace"), dataDir = join(root, "data");
for (const dir of [agentDir, cwd, dataDir]) mkdirSync(dir);
const TOOL_RESULT = "PRIOR_TOOL_PROGRESS_573819: this step completed successfully";
const BAD = "REPETITION_POISON_92716 Emit.";
writeFileSync(join(cwd, "progress.txt"), TOOL_RESULT);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultTools: ["read"], defaultThinkingLevel: "high", compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
writeFileSync(join(agentDir, "webui-extensions.json"), JSON.stringify({ autoCheck: false }));
const requests = new Map(), streams = new Map(), timers = new Set(), clients = [];
let harness, fixtureError;
const text = content => typeof content === "string" ? content : (content ?? []).map(block => block.text ?? "").join("\n");
const count = name => requests.get(name)?.length ?? 0;

function chunk(res, delta, finish = null) {
	if (!res.destroyed) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function finish(res, body, reason = "stop", thinking = false) {
	chunk(res, thinking ? { reasoning_content: body } : { content: body });
	chunk(res, {}, reason);
	res.end("data: [DONE]\n\n");
}
function repeat(res, thinking = false) {
	// Keep the stream open until the real SDK aborts its HTTP request.
	const send = () => chunk(res, thinking ? { reasoning_content: `${BAD}\n`.repeat(8) } : { content: `${BAD}\n`.repeat(8) });
	send();
	const timer = setInterval(send, 15); timers.add(timer);
	res.once("close", () => { clearInterval(timer); timers.delete(timer); });
}
const model = createServer((req, res) => { void (async () => {
	let raw = ""; for await (const part of req) raw += part;
	const body = JSON.parse(raw);
	const name = body.messages.map(message => text(message.content)).join("\n").match(/CASE:([a-z_]+)/)?.[1];
	assert(name, "fixture request retains the original user task");
	const history = requests.get(name) ?? []; requests.set(name, history); history.push(body);
	const nth = history.length;
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.flushHeaders(); streams.set(`${name}:${nth}`, res);
	if (name === "length_once") return finish(res, nth === 1 ? "The first part explains the request lifecycle and records the observed state." : "RECOVERED_length_once", nth === 1 ? "length" : "stop");
	if (name === "length_exhaust") return finish(res, `Partial result number ${nth}: the next section has not yet been completed.`, "length");
	if (name === "thinking_only") return finish(res, "Consider the available evidence and select a useful next step.", "length", true);
	if (name === "text_progress" || name === "thinking_progress") {
		if (nth === 1) {
			chunk(res, { tool_calls: [{ index: 0, id: `read-${name}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(cwd, "progress.txt") }) } }] });
			chunk(res, {}, "tool_calls"); return res.end("data: [DONE]\n\n");
		}
		if (nth === 2) return repeat(res, name === "thinking_progress");
		return finish(res, `RECOVERED_${name}`);
	}
	if (name === "repeat_twice") return repeat(res);
	if (name === "manual" || name === "foreground" || (name === "background" && nth === 1)) {
		chunk(res, { content: "The fixture is waiting for the next test action." }); return;
	}
	if (name === "background") return finish(res, "RECOVERED_background");
	if (name === "disabled") return finish(res, `${BAD}\n`.repeat(160));
	throw Error(`Unknown scenario ${name}`);
})().catch(error => {
	fixtureError ??= error;
	if (!res.destroyed) res.destroy(error);
}); });

async function wait(check, label, timeout = 15000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (fixtureError) throw fixtureError;
		if (harness?.child.exitCode != null) throw Error(`Harness exited: ${harness.logs}`);
		const value = check(); if (value) return value;
		await sleep(20);
	}
	throw Error(`Timeout: ${label}; counts=${JSON.stringify(Object.fromEntries([...requests].map(([name, list]) => [name, list.length])))}; states=${JSON.stringify(clients.map(client => ({ streaming: client.state?.isStreaming, recovery: client.state?.runRecovery, last: client.state?.messages.at(-1), notices: client.wire.filter(message => message.type === "notice").slice(-3) })))}\n${harness?.logs ?? ""}`);
}
async function connect() {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	const client = { ws, state: undefined, wire: [], send: value => ws.send(JSON.stringify(value)) }; clients.push(client);
	ws.on("message", raw => {
		const message = JSON.parse(raw); client.wire.push(message);
		if (message.type === "snapshot") client.state = message.state;
		else if (message.type === "snapshot_delta" && client.state) {
			if (client.state.conversationId !== message.conversationId || client.state.rev !== message.baseRev) client.send({ type: "get_state" });
			else client.state = { ...client.state, ...message.state, messages: [...client.state.messages, ...message.appended] };
		}
	});
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	client.send({ type: "hello", clientId: `run-recovery-fixture-${clients.length}`, protocolVersion: PROTOCOL_VERSION });
	await wait(() => client.state && !client.state.tree?.verifying, "initial snapshot");
	return client;
}
async function fresh(client) {
	const previous = client.state.conversationId;
	client.send({ type: "new_chat" });
	await wait(() => client.state.conversationId !== previous && !client.state.tree?.verifying, "fresh conversation");
	return client.state.conversationId;
}
async function prompt(client, name) {
	const { cwd: workdir, conversationId, sessionId } = client.state;
	client.send({ type: "prompt", requestId: name, text: `CASE:${name} Complete the pending investigation.`, target: { cwd: workdir, conversationId, sessionId } });
	const receipt = await wait(() => client.wire.find(message => message.type === "prompt_result" && message.requestId === name), `${name} accepted`);
	assert.equal(receipt.ok, true, JSON.stringify(receipt));
}
async function settled(client, name, expectedCalls, predicate = () => true) {
	await wait(() => count(name) >= expectedCalls && !client.state.isStreaming && predicate(client.state), `${name} settled`);
	await sleep(400);
	client.send({ type: "get_state" }); await sleep(60);
	assert.equal(count(name), expectedCalls, `${name}: bounded number of provider requests`);
	assert.equal(client.state.isStreaming, false);
}
function assertQuarantined(client, name) {
	const file = client.state.sessionFile;
	assert(file, "real SDK persisted the session");
	const entries = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
	const bad = entries.filter(entry => entry.type === "message" && entry.message.role === "assistant" && JSON.stringify(entry.message.content).includes(BAD));
	assert(bad.length > 0, `${name}: original incident remains inspectable in native history`);
	for (const entry of bad) {
		assert.equal(entry.message.stopReason, "aborted", "preserve the SDK stop reason");
		assert(entries.some(edit => edit.type === "context_edit" && edit.targetId === entry.id && edit.replacement === null), "isolation is a durable native context edit");
	}
	const restored = SessionManager.open(file).buildSessionContext().messages;
	assert(!JSON.stringify(restored).includes(BAD), "reopened context excludes the poisoned assistant");
	return restored;
}

try {
	const modelPort = await listenIsolated(model);
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: "fixture", models: [{ id: "fixture", name: "Recovery fixture", input: ["text"], reasoning: true, contextWindow: 1000000, maxTokens: 128000 }] } } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir } });
	let client = await connect();
	await prompt(client, "length_once");
	await settled(client, "length_once", 2, state => !state.runRecovery && JSON.stringify(state.messages).includes("RECOVERED_length_once"));
	const firstRequest = requests.get("length_once")[0];
	assert.equal(firstRequest.max_tokens ?? firstRequest.max_completion_tokens, 128000, "recovery does not lower the existing default output allowance");
	assert(JSON.stringify(requests.get("length_once")[1].messages).includes("The first part explains"), "length continuation retains the unfinished answer");
	console.log("PASS length continues once and retains the partial answer");
	await fresh(client); await prompt(client, "length_exhaust");
	await settled(client, "length_exhaust", 3, state => state.runRecovery?.phase === "stopped");
	assert.equal(client.state.runRecovery.reason, "length");
	assert.equal(client.state.runRecovery.detail, "exhausted");
	assert.equal(client.state.runRecovery.attempt, 2);
	console.log("PASS length recovery stops after two additional model requests");
	await fresh(client); await prompt(client, "thinking_only");
	await settled(client, "thinking_only", 1, state => state.runRecovery?.phase === "stopped");
	assert.equal(client.state.runRecovery.detail, "thinking-only");
	console.log("PASS thinking-only length stop does not auto-continue");
	const { serializeConversation } = await import(pathToFileURL(join(getPackageDir(), "dist/core/compaction/utils.js")));
	for (const name of ["text_progress", "thinking_progress"]) {
		await fresh(client); await prompt(client, name);
		await settled(client, name, 3, state => !state.runRecovery && JSON.stringify(state.messages).includes(`RECOVERED_${name}`));
		const recovery = requests.get(name)[2].messages;
		assert(recovery.some(message => message.role === "tool" && text(message.content).includes(TOOL_RESULT)), "continuation retains the already completed real tool result");
		assert(!JSON.stringify(recovery).includes(BAD), "recovery request excludes repetitive content");
		assert.equal(recovery.filter(message => message.role === "user" && text(message.content).includes(`CASE:${name}`)).length, 1, "original task is not replayed");
		const context = assertQuarantined(client, name);
		assert(!serializeConversation(context).includes(BAD), "native compaction/branch-summary serialization also excludes the quarantined text");
		assert(serializeConversation(context).includes(TOOL_RESULT));
		console.log(`PASS ${name}: abort, one continuation, preserved tool progress and durable summary-safe isolation`);
	}
	await fresh(client); await prompt(client, "repeat_twice");
	await settled(client, "repeat_twice", 2, state => state.runRecovery?.phase === "stopped");
	assert.equal(client.state.runRecovery.reason, "repetition");
	assert.equal(client.state.runRecovery.detail, "exhausted");
	assertQuarantined(client, "repeat_twice");
	console.log("PASS repeated recovery failure stops without a third model request");
	await fresh(client); await prompt(client, "manual");
	await wait(() => count("manual") === 1 && client.state.isStreaming, "manual request started");
	const manualWireStart = client.wire.length;
	client.send({ type: "abort" });
	await settled(client, "manual", 1);
	assert(streams.get("manual:1").destroyed, "manual stop cancels the HTTP stream");
	assert(!client.wire.slice(manualWireStart).some(message => message.type === "notice" && /强制重置/.test(message.text)), "native settled reaches Stop even when prompt-delivery unsubscribes during that event");
	console.log("PASS manual Stop never starts recovery");
	// Use another client session group so the fixture does not exhaust the
	// intentional eight-conversation limit while retaining earlier audit files.
	client = await connect();
	await fresh(client); await prompt(client, "background");
	const backgroundId = client.state.conversationId;
	await wait(() => streams.has("background:1"), "background stream started");
	const foregroundId = await fresh(client); await prompt(client, "foreground");
	await wait(() => streams.has("foreground:1"), "foreground stream started");
	repeat(streams.get("background:1"));
	await wait(() => count("background") === 2, "background recovery request");
	assert.equal(client.state.conversationId, foregroundId);
	assert.equal(client.state.isStreaming, true, "background recovery must not stop the active conversation");
	assert.equal(streams.get("foreground:1").destroyed, false);
	client.send({ type: "switch_conversation", id: backgroundId });
	await wait(() => client.state.conversationId === backgroundId, "switch to recovered background");
	await settled(client, "background", 2, state => JSON.stringify(state.messages).includes("RECOVERED_background"));
	assertQuarantined(client, "background");
	client.send({ type: "switch_conversation", id: foregroundId });
	await wait(() => client.state.conversationId === foregroundId, "switch to running foreground");
	client.send({ type: "abort" }); await settled(client, "foreground", 1);
	console.log("PASS background repetition recovers its own conversation and leaves foreground running");
	await fresh(client);
	client.send({ type: "set_run_settings", conversationId: client.state.conversationId, repetitionProtection: false });
	await wait(() => client.state.runSettings?.repetitionProtection === false, "disable repetition protection");
	await prompt(client, "disabled"); await settled(client, "disabled", 1);
	assert(JSON.stringify(client.state.messages).includes(BAD), "disabled protection permits intentional repeated output");
	console.log("PASS per-conversation repetition protection can be disabled");
} finally {
	for (const timer of timers) clearInterval(timer);
	for (const client of clients) client.ws.terminate();
	await harness?.stop();
	model.closeAllConnections();
	if (model.listening) await new Promise(resolve => model.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
