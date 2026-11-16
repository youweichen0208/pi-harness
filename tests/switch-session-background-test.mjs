// Opening a persisted history session must not abort a response that is
// already streaming in another conversation.
//
// Usage: npm run build && node tests/switch-session-background-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";

const base = mkdtempSync(join(tmpdir(), "pi-web-switch-session-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(dataDir, "omp/agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

let finish, requests = 0;
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		res.writeHead(400).end("bad json");
		return;
	}
	const last = payload.messages?.at(-1);
	const prompt = typeof last?.content === "string"
		? last.content
		: last?.content?.filter?.((part) => part.type === "text").map((part) => part.text).join(" ") ?? "";
	requests++;
	const slow = prompt.includes("SLOW");
	const first = slow ? "background-" : "seed-";
	const lastChunk = slow ? "finished" : "message";
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
	});
	const writeChunk = (content) => res.write(
		`data: ${JSON.stringify({
			id: "switch-session-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: { content }, finish_reason: null }],
		})}\n\n`,
	);
	writeChunk(first);
	if (slow) await new Promise(resolve => { finish = resolve; });
	writeChunk(lastChunk);
	res.write(
		`data: ${JSON.stringify({
			id: "switch-session-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
});
let harness;

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		this.messages = [];
		this.conversations = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
				this.messages = message.state.messages ?? [];
			} else if (
				message.type === "snapshot_delta" &&
				this.state &&
				this.state.rev === message.baseRev &&
				message.conversationId === this.state.conversationId
			) {
				this.state = { ...this.state, ...message.state };
				this.messages = [...this.messages, ...message.appended];
			} else if (message.type === "conversations") {
				this.conversations = message.conversations;
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const message = this.received[i];
				if (message.type !== type || !predicate(message)) continue;
				this.received.splice(i, 1);
				return message;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
	async waitForMessage(predicate, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const message = this.messages.find(predicate);
			if (message) return message;
			await sleep(50);
		}
		throw new Error("timeout waiting for message");
	}
}

let client;
try {
	const mockPort = await listenIsolated(mock);
	writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "models.yml"), JSON.stringify({ providers: { main: { api: "openai-completions", baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: "fixture-only", models: [{ id: "switch-session-mock", name: "Fixture", input: ["text"], contextWindow: 32000 }] } } }));
	harness = await startIsolatedHarness({ ...(process.argv.includes("--source") ? { args: ["--import", "tsx", "server/index.ts"] } : {}), env: { PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: workdir } });
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	client = new Client(ws);
	client.send({ type: "hello", clientId: "switch-session-background-test" });
	await client.waitForType("ready");
	await client.waitForState((state) => Boolean(state.conversationId));

	client.send({ type: "set_model", modelId: "main/switch-session-mock" });
	await client.waitForState((state) => state.model?.id === "switch-session-mock");

	client.send({ type: "prompt", text: "seed" });
	await client.waitForMessage((message) => message.role === "assistant");
	await client.waitForState(state => !state.isStreaming);
	const historyPath = client.state.sessionFile;
	if (!historyPath) throw new Error("seed session was not persisted");

	const seedConversationId = client.state.conversationId;
	client.send({ type: "new_chat" });
	await client.waitForState((state) => state.conversationId !== seedConversationId && !state.isStreaming);

	client.send({ type: "prompt", text: "SLOW background run" });
	const streamingState = await client.waitForState(
		(state) => finish && state.isStreaming && state.conversationId !== seedConversationId,
	);
	const backgroundConversationId = streamingState.conversationId;

	client.send({ type: "switch_session", path: historyPath });
	await client.waitForState((state) => state.conversationId !== backgroundConversationId);
	await client.waitForType(
		"conversations",
		(message) => message.conversations.some(
			(conversation) =>
				conversation.id === backgroundConversationId && conversation.isStreaming,
		),
	);
	console.log("✓ history switch leaves the active stream running in background");
	client.send({ type: "delete_session", path: streamingState.sessionFile });
	await client.waitForType("notice", (m) => m.level === "warning" && m.text.includes("后台任务"));
	console.log("✓ deleting a background streaming session is refused");
	if (requests !== 2) throw Error("History switch must not issue another model request");
	finish();


	await client.waitForType(
		"conversations",
		(message) => message.conversations.some(
			(conversation) =>
				conversation.id === backgroundConversationId && !conversation.isStreaming,
		),
		15000,
	);
	client.send({ type: "switch_conversation", id: backgroundConversationId });
	await client.waitForState((state) => state.conversationId === backgroundConversationId);
	await client.waitForMessage(
		(message) =>
			message.role === "assistant" &&
			JSON.stringify(message.content).includes("background-finished"),
	);
	await client.waitForState(state => !state.isStreaming);
	if (requests !== 2) throw Error("Background completion must not retry or replay a prompt");
	console.log("✓ background response completes and remains recoverable");
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	client?.ws.terminate();
	finish?.();
	await harness?.stop(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	rmSync(base, { recursive: true, force: true });
}
