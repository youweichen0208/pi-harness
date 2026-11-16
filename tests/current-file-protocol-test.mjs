// Real SDK and local mock provider: frozen editor drafts, queue delivery and history reask.
import assert from "node:assert/strict";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { scrubHostEnv } from "./lib/test-env.mjs";
scrubHostEnv();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_/.test(key)) delete process.env[key];

const base = realpathSync(mkdtempSync(join(tmpdir(), "omp-current-file-")));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(dataDir, "omp/agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const queueSkillBody = "Queue skill instructions\n".repeat(200);
mkdirSync(join(agentDir, "skills", "queue-ops"), { recursive: true });
writeFileSync(join(agentDir, "skills", "queue-ops", "SKILL.md"), "---\nname: queue-ops\ndescription: Queue preview fixture\n---\n" + queueSkillBody);


const markdown = '# Markdown attachment\n```ts\nconst s = "a  b";\n```\n';
writeFileSync(join(workdir, "guide.md"), markdown);
mkdirSync(join(agentDir, "prompts"));
writeFileSync(join(agentDir, "prompts", "fixture-review.md"), "Review carefully: $@");
const requests = [];
writeFileSync(join(workdir, "note.txt"), "disk original");
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
	if (payload.tools?.length) requests.push(payload);
	const last = payload.messages?.at(-1);
	const prompt = typeof last?.content === "string"
		? last.content
		: last?.content?.filter?.((part) => part.type === "text").map((part) => part.text).join(" ") ?? "";
	const slow = prompt === "SLOW";
	const first = slow ? "background-" : "seed-";
	const lastChunk = (slow ? "finished" : "message") + ` [fixture-reply-${requests.length}]`;
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
	res.write(`data: ${JSON.stringify({ id: "thinking-test", object: "chat.completion.chunk", created: Date.now(), model: payload.model, choices: [{ index: 0, delta: { reasoning_content: "Check the draft" }, finish_reason: null }] })}\n\n`);
	await sleep(150);
	writeChunk(first);
	if (slow) await sleep(2500);
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
const MOCK_PORT = await listenIsolated(mock);

writeFileSync(join(agentDir, "config.yml"), JSON.stringify({
	skills: { enabled: true, enableAgentsUser: false, enableAgentsProject: false, enablePiUser: false, enablePiProject: false, enableClaudeUser: false, enableClaudeProject: false, enableCodexUser: false, customDirectories: [join(agentDir, "skills")] },
	retry: { enabled: false }, cacheWarming: { enabled: false }, compaction: { enabled: false },
}));
writeFileSync(
	join(agentDir, "models.yml"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "switch-session-test",
				models: [{
					id: "switch-session-mock",
					name: "Switch Session Mock",
					input: ["text"],
					contextWindow: 32000,
					maxTokens: 4096,
				}],
			},
		},
	}),
);

let harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: workdir } });
const PORT = harness.port;

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
		throw new Error(`timeout waiting for state (${requests.length} model requests)`);
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
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	client = new Client(ws);
	client.send({ type: "hello", clientId: "current-file-protocol" });
	await client.waitForType("ready");
	await client.waitForState((s) => Boolean(s.conversationId));
	client.send({ type: "set_model", modelId: "main/switch-session-mock" });
	await client.waitForState((s) => s.model?.id === "switch-session-mock");
	const sendDraft = (requestId, draft, queue = false) => client.send({ type: "prompt", requestId, queue, text: requestId, attachments: [{ path: "note.txt", editorSnapshot: { cwd: workdir, text: draft, dirty: true } }, { path: "guide.md", mode: "inline" }] });
	sendDraft("normal", "DRAFT_NORMAL");
	assert.equal((await client.waitForType("prompt_result", (m) => m.requestId === "normal")).ok, true);
	await client.waitForMessage((m) => m.role === "assistant");
	const thought = client.messages.find((m) => m.role === "assistant")?.content.find((b) => b.type === "thinking");
	assert(thought && thought.durationMs >= 100, `real SDK thinking duration: ${JSON.stringify(thought)}`);
	assert(JSON.stringify(requests[0]).includes("DRAFT_NORMAL"));
	assert(JSON.stringify(requests[0]).includes("Prioritize"));
	assert(!JSON.stringify(requests[0]).includes("disk original"));
	await client.waitForState((s) => !s.isStreaming);
	const savedThinking = JSON.parse(readFileSync(join(dataDir, "omp/thinking-durations.json"), "utf8"));
	assert(Object.values(savedThinking).some((blocks) => Object.values(blocks).some((ms) => ms >= 100)), "completed thinking duration is persisted");
	const measuredMs = thought.durationMs, savedSessionId = client.state.sessionId, savedFile = client.state.sessionFile;
	client.ws.terminate(); await harness.stop();
	const historyBeforeRestart = readFileSync(savedFile);
	harness = await startIsolatedHarness({ env: { PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: workdir }, nextPort: () => PORT, attempts: 1 });
	const restoredSocket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	client = new Client(restoredSocket);
	await new Promise((resolve, reject) => { restoredSocket.once("open", resolve); restoredSocket.once("error", reject); });
	client.send({ type: "hello", clientId: "current-file-protocol" });
	await client.waitForType("ready"); client.send({ type: "get_state" });
	await client.waitForState(state => state.sessionId === savedSessionId && state.messages.some(message => message.role === "assistant"));
	assert.equal(client.messages.find(message => message.role === "assistant").content.find(block => block.type === "thinking").durationMs, measuredMs);
	assert.deepEqual(readFileSync(savedFile), historyBeforeRestart, "timing restoration must not rewrite native history");
	assert.equal(requests.length, 1, "host restart must not call the model");
	console.log("PASS OMP thinking timing: native stream, host restart and unchanged transcript");
	client.send({ type: "prompt", text: "SLOW" });
	await client.waitForState((s) => s.isStreaming);
	sendDraft("steering", "DRAFT_STEER");
	assert.equal((await client.waitForType("prompt_result", (m) => m.requestId === "steering")).ok, true);
	sendDraft("followup", "DRAFT_FOLLOWUP", true);
	assert.equal((await client.waitForType("prompt_result", (m) => m.requestId === "followup")).ok, true);
	for (let n = 0; n < 200 && requests.length < 4; n++) await sleep(50);
	assert.equal(requests.length, 4);
	assert(JSON.stringify(requests[2]).includes("DRAFT_STEER"));
	assert(!JSON.stringify(requests[2]).includes("DRAFT_FOLLOWUP"));
	assert(JSON.stringify(requests[3]).includes("DRAFT_FOLLOWUP"));
	await client.waitForMessage((m) => m.role === "user" && m.content.some(b => b.text?.includes("DRAFT_FOLLOWUP")));
	await client.waitForState((s) => !s.isStreaming);
	const originalQuestion = client.messages.find((m) => m.role === "user" && m.content.some((b) => b.text?.startsWith("normal\n")));
	assert(originalQuestion);
	const originalText = originalQuestion.content.filter(b => b.type === "text").map(b => b.text).join("\n");
	assert(originalText.includes("DRAFT_NORMAL"));
	assert.equal(originalQuestion.questionText, "normal");
	assert.equal(originalQuestion.userAttachments.length, 2);
	assert.equal(originalQuestion.userAttachments[1].preview, markdown);
	rmSync(join(workdir, "guide.md"));
	rmSync(join(workdir, "note.txt"));
	client.send({ type: "edit_message", messageId: originalQuestion.id, text: "reask original", attachments: originalQuestion.userAttachments.map(({path, mode, nativeRef}) => ({path, mode, nativeRef})) });
	for (let n = 0; n < 200 && requests.length < 5; n++) await sleep(50);
	assert.equal(requests.length, 5);
	assert(JSON.stringify(requests[4]).includes("DRAFT_NORMAL"));
	assert(!JSON.stringify(requests[4]).includes("DRAFT_FOLLOWUP"));
	assert(JSON.stringify(requests[4]).includes(JSON.stringify(markdown).slice(1, -1)));
	writeFileSync(join(workdir, "note.txt"), "disk changed");
	await client.waitForState(s => !s.isStreaming && !s.tree?.verifying);
	client.send({ type: "prompt", text: "SLOW" });
	await client.waitForState(s => s.isStreaming);
	client.send({ type: "prompt", requestId: "recalled", queue: true, text: "never send this", attachments: [{ path: "note.txt", editorSnapshot: { cwd: workdir, text: "RECALLED_DRAFT", dirty: true } }] });
	assert.equal((await client.waitForType("prompt_result", m => m.requestId === "recalled")).ok, true);
	client.send({ type: "prompt", requestId: "queued-skill", queue: true, text: "/skill:queue-ops 检查状态" });
	assert.equal((await client.waitForType("prompt_result", m => m.requestId === "queued-skill")).ok, true);
	await client.waitForState(s => s.queue.followUp.includes("/skill:queue-ops 检查状态"));
	assert(!client.state.queue.followUp.some(text => text.includes("Queue skill instructions")));
	const conversationId = client.state.conversationId;
	client.send({ type: "recall_queue", conversationId: "wrong", requestId: "wrong-recall" });
	await sleep(50);
	assert(client.state.queue.followUp.length > 0);
	client.send({ type: "recall_queue", conversationId, requestId: "recall" });
	const recalled = await client.waitForType("queue_recalled", m => m.requestId === "recall");
	assert(recalled.text.includes("RECALLED_DRAFT"));
	assert(recalled.text.includes("/skill:queue-ops 检查状态"), "OMP restores the user invocation, not its generated skill body");
	assert(!recalled.text.includes(queueSkillBody.trim()));
	assert(recalled.text.includes("检查状态"));
	client.send({ type: "recall_queue", conversationId, requestId: "recall" });
	assert.deepEqual(await client.waitForType("queue_recalled", m => m.requestId === "recall"), recalled);
	const reconnect = async () => {
		const closed = new Promise(resolve => client.ws.once("close", resolve));
		client.ws.close(); await closed;
		const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
		client = new Client(socket);
		client.send({ type: "hello", clientId: "current-file-protocol" });
		await client.waitForType("ready");
		client.send({ type: "get_state" });
	};
	await reconnect();
	assert.deepEqual(await client.waitForType("queue_recalled", m => m.requestId === "recall"), recalled, "unacknowledged recall survives reconnect");
	client.send({ type: "queue_recall_ack", conversationId, requestId: "recall" });
	await client.waitForState(s => !s.isStreaming && s.queue.followUp.length === 0);
	await reconnect();
	await client.waitForState(s => s.conversationId === conversationId);
	await sleep(200);
	assert(!client.received.some(m => m.type === "queue_recalled"), "acknowledged recall is not replayed");
	assert(!JSON.stringify(requests).includes("RECALLED_DRAFT"));

	const beforeSkill = requests.length;
	client.send({ type: "prompt", requestId: "skill-parent", text: "SLOW" });
	await client.waitForState(s => s.isStreaming);
	client.send({ type: "prompt", requestId: "delivered-skill", queue: true, text: "/skill:queue-ops DELIVER_NATIVE_SKILL" });
	assert.equal((await client.waitForType("prompt_result", m => m.requestId === "delivered-skill")).ok, true);
	for (let n = 0; n < 600 && requests.length < beforeSkill + 2; n++) await sleep(50);
	assert.equal(requests.length, beforeSkill + 2);
	assert(JSON.stringify(requests.at(-1)).includes(JSON.stringify(queueSkillBody.trim()).slice(1, -1)), "queued skills must expand through the native prompt pipeline");
	assert(JSON.stringify(requests.at(-1)).includes("DELIVER_NATIVE_SKILL"));
	const waitForReply = count => client.waitForState(s => !s.isStreaming && !s.tree?.verifying && client.messages.some(m => m.role === "assistant" && m.content.some(b => b.type === "text" && b.text.includes(`[fixture-reply-${count}]`))));
	await waitForReply(beforeSkill + 2);
	await client.waitForMessage(m => m.role === "user" && m.entryId && m.content.some(b => b.type === "text" && b.text === "/skill:queue-ops DELIVER_NATIVE_SKILL"));

	writeFileSync(join(workdir, "guide.md"), markdown);
	const lastRequestText = () => {
		const content = requests.at(-1).messages.at(-1).content;
		return typeof content === "string" ? content : content.filter(b => b.type === "text").map(b => b.text).join("\n");
	};
	for (const [index, separator] of [" ", "\n", "\t", "\r\n"].entries()) {
		// Compare with the same invocation through unmodified native expansion.
		// OMP recognizes a literal space; other separators remain ordinary text.
		const invocation = `/fixture-review${separator}"one two" three`;
		const baselineCount = requests.length;
		client.send({ type: "prompt", requestId: `template-baseline-${index}`, text: invocation });
		assert.equal((await client.waitForType("prompt_result", m => m.requestId === `template-baseline-${index}`)).ok, true);
		for (let n = 0; n < 200 && requests.length === baselineCount; n++) await sleep(50);
		assert.equal(requests.length, baselineCount + 1);
		await waitForReply(baselineCount + 1);
		const nativeText = lastRequestText();
		assert(nativeText.startsWith(separator === " " ? "Review carefully: one two three" : invocation), `native separator behavior: ${JSON.stringify(separator)}`);
		const count = requests.length;
		const requestId = `template-${index}`;
		client.send({ type: "prompt", requestId, text: invocation, attachments: [{ path: "guide.md", mode: "inline" }] });
		assert.equal((await client.waitForType("prompt_result", m => m.requestId === requestId)).ok, true);
		for (let n = 0; n < 200 && requests.length === count; n++) await sleep(50);
		assert.equal(requests.length, count + 1);
		await waitForReply(count + 1);
		const text = lastRequestText();
		assert(text.startsWith(nativeText), `attachments must retain native invocation behavior: ${JSON.stringify(separator)}; native=${JSON.stringify(nativeText.slice(0, 140))}; attached=${JSON.stringify(text.slice(0, 140))}`);
		assert(text.includes(markdown), "template expansion must preserve attachment whitespace and quotes");
	}
	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core");
		const { CHROME_PATH } = await import("./lib/chrome.mjs");
		const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
		try {
			const page = await browser.newPage();
			await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "current-file-protocol"));
			await page.goto(`http://127.0.0.1:${PORT}`);
			const card = page.locator(".user-attachment-card").first();
			await card.waitFor(); await card.locator("summary").click();
			assert((await card.locator("pre").textContent()).includes("DRAFT_NORMAL"));
			const markdownCard = page.locator(".user-attachment-card").nth(1);
			await markdownCard.locator("summary").click();
			assert.equal(await markdownCard.locator("pre").textContent(), markdown);
			await page.getByRole("button", { name: "编辑重问", exact: true }).first().click();
			const editor = page.locator(".msg textarea");
			assert.equal(await editor.inputValue(), "reask original");
			assert.equal(await page.locator(".msg-editor-img.file-chip").count(), 2);
		} finally { await browser.close(); }
	}
	console.log("PASS actual SDK/model protocol: ordinary, steer, followUp receive frozen snapshots; history/reask and queued skills preserved; template attachments retain exact bytes and native separator behavior; disk unchanged");
} finally {
	client?.ws.close();
	await harness.stop();
	mock.closeAllConnections();
	await new Promise((resolve) => mock.close(resolve));
	rmSync(base, { recursive: true, force: true });
}
