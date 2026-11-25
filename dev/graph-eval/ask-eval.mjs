// Explicit, billed experiment on exactly the bytes pinned in corpus.json.
// Each arm uses a separate harness process, HOME, session and project registry.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "../../tests/lib/isolated-server.mjs";
import { discoverModels } from "../../dist/server/model-sources.js";
import { WorkspaceGraphService } from "../../dist/server/workspace-graph.js";
import { PROTOCOL_VERSION } from "../../dist/server/protocol-version.js";

const [modelId, ...arms] = process.argv.slice(2);
if (!modelId || !arms.length || !arms.every(name => ["A", "B", "C"].includes(name))) throw Error("Usage: node dev/graph-eval/ask-eval.mjs MODEL_ID A B C");
const candidates = discoverModels().connections.filter(c => c.id === modelId);
if (candidates.length !== 1 || candidates[0].api !== "anthropic-messages") throw Error("Choose a uniquely configured Anthropic-compatible model from pi-harness model sources");
const connection = candidates[0];
const project = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf8"));
const sha = value => createHash("sha256").update(value).digest("hex");
const question = "Trace the native SDK event that sets conv.lastTaskEndedAt in the web host. Show the emitter, listener registration and dispatch, typed receiver, host callback, matching branch and assignment. Does the neighboring extension-runner emit establish this subscription? Cite the original lines. Keep the answer under 250 words.";
const expected = { "sdk/packages/coding-agent/src/core/agent-session.ts": [1150, 1106, 1458], "harness/server/conversation.ts": [47], "harness/server/agent-service.ts": [935, 938, 1088, 1092] };
async function wait(fn, ms) {
	const deadline = Date.now() + ms;
	while (!fn()) { if (Date.now() > deadline) throw Error("Evaluation deadline exceeded"); await sleep(50); }
}

async function relay(skillFile, skillBytes) {
	const endpoint = new URL(connection.baseUrl);
	if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["https:", "http:"].includes(endpoint.protocol)) throw Error("Invalid model base URL");
	endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/v1/messages";
	const stats = { calls: 0, capped: false, skillVerified: false, tools: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0, metered: 0 };
	const abort = new AbortController();
	const server = createServer(async (req, res) => {
		try {
			if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/messages") { res.writeHead(404).end(); return; }
			if (stats.calls >= 16) { stats.capped = true; res.writeHead(400).end("Evaluation call budget reached"); return; }
			let raw = "";
			for await (const part of req) raw += part;
			const body = JSON.parse(raw);
			const visible = body.messages.flatMap(message => typeof message.content === "string" ? [message.content]
				: (message.content ?? []).filter(block => block.type === "text").map(block => block.text)).join("\n");
			if (!stats.calls) {
				if (!visible.includes(skillFile) || !visible.includes(skillBytes.includes("independent repositories, a large module") ? "independent repositories, a large module" : "Trace the question yourself")) throw Error("Actual Ask expansion did not match selected arm");
				stats.skillVerified = true;
				stats.tools = body.tools?.map(tool => tool.name).sort() ?? [];
			}
			body.max_tokens = Math.min(body.max_tokens ?? 1800, 1800);
			stats.calls++;
			const headers = { "content-type": "application/json", "anthropic-version": req.headers["anthropic-version"] ?? "2023-06-01", ...connection.headers };
			if (!Object.keys(headers).some(k => ["x-api-key", "authorization"].includes(k.toLowerCase()))) {
				if (connection.authentication === "bearer") headers.authorization = "Bearer " + connection.key;
				else headers["x-api-key"] = connection.key;
			}
			const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: abort.signal });
			if (!response.ok || !response.body) { res.writeHead(response.status).end("Configured provider returned error"); return; }
			res.writeHead(200, { "content-type": "text/event-stream" });
			let pending = "", finalOutput;
			const decoder = new TextDecoder();
			for await (const chunk of response.body) {
				res.write(chunk); pending += decoder.decode(chunk, { stream: true });
				const lines = pending.split("\n"); pending = lines.pop();
				for (const line of lines) {
					if (!line.startsWith("data:")) continue;
					let event; try { event = JSON.parse(line.slice(5).trimStart()); } catch { continue; }
					if (event.type === "message_start" && event.message?.usage) {
						const u = event.message.usage;
						stats.input += u.input_tokens ?? 0; stats.cacheRead += u.cache_read_input_tokens ?? 0; stats.cacheWrite += u.cache_creation_input_tokens ?? 0;
					}
					if (event.type === "message_delta" && Number.isInteger(event.usage?.output_tokens)) finalOutput = event.usage.output_tokens;
				}
			}
			if (finalOutput !== undefined) { stats.output += finalOutput; stats.metered++; }
			res.end();
		} catch { if (!res.headersSent) res.writeHead(502); res.end("Evaluation relay could not complete request"); }
	});
	const port = await listenIsolated(server);
	return { port, stats, close: async () => { abort.abort(); server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}

async function run(arm) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-ask-graph-")));
	const agent = join(root, "agent"), data = join(root, "data"), home = join(root, "home");
	const samples = join(project, ".scratch/graph-eval/samples");
	const hashes = {};
	let transport, harness, ws, state;
	try {
		for (const p of [agent,data,home]) mkdirSync(p);
		for (const [source, entry] of Object.entries(manifest)) for (const [file, digest] of Object.entries(entry.files)) {
			const rel = source + "/" + file, bytes = readFileSync(join(samples, rel));
			assert.equal(sha(bytes), digest);
			mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), bytes);
			hashes[rel] = digest;
		}
		const catalog = { revision: 0, workspaces: [{ id: "public-case", name: "Public sample", paths: Object.keys(manifest).map(id => join(root, id)) }] };
		writeFileSync(join(data, "project-workspaces.json"), JSON.stringify(catalog));
		const graph = new WorkspaceGraphService(data, () => catalog);
		try {
			await graph.execute("public-case", { op: "graph_build" });
			let status;
			for (let i = 0; i < 200; i++) {
				status = await graph.execute("public-case", { op: "graph_status" });
				if (status.state === "ready" || status.state === "failed") break;
				await sleep(100);
			}
			assert.equal(status?.state, "ready", status?.error);
		} finally { await graph.close(); }
		let skillFile = join(project, "assets/skills/ask/SKILL.md");
		if (arm === "A") {
			skillFile = join(agent, "skills/ask/SKILL.md");
			mkdirSync(dirname(skillFile), { recursive: true });
			writeFileSync(skillFile, readFileSync(new URL("./ask-baseline.md", import.meta.url)));
		}
		const skillBytes = readFileSync(skillFile, "utf8");
		transport = await relay(skillFile, skillBytes);
		writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "anthropic-messages", baseUrl: "http://127.0.0.1:" + transport.port, apiKey: "local-relay", models: [{ id: modelId, input: ["text"], contextWindow: connection.contextWindow, maxTokens: 1800, reasoning: false }] } } }));
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: modelId, defaultThinkingLevel: "off", retry: {enabled:false}, compaction: {enabled:false}, cacheWarming:"off" }));
		harness = await startIsolatedHarness({ env: { PI_WEB_PKG_ROOT: project, PI_WEB_TOKEN: "", PI_WEB_CWD: join(root, "harness"), PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent, HOME: home, USERPROFILE: home } });
		ws = new WebSocket("ws://127.0.0.1:" + harness.port + "/ws");
		const send = m => ws.send(JSON.stringify(m)), replies = new Map(), observed = new Map();
		ws.on("message", bytes => {
			const m = JSON.parse(bytes);
			if (m.type === "snapshot") state = m.state;
			if (m.type === "snapshot_delta" && state) state = { ...state, ...m.state, messages: [...state.messages, ...m.appended ?? []] };
			if (m.requestId) replies.set(m.requestId, m);
			for (const msg of state?.messages ?? []) if (msg.role === "toolResult" && !observed.has(msg.toolCallId)) observed.set(msg.toolCallId, Date.now());
		});
		await new Promise((yes,no) => { ws.once("open",yes); ws.once("error",no); });
		send({ type: "hello", clientId: "ask-eval-" + arm, protocolVersion: PROTOCOL_VERSION });
		await wait(() => state && !state.tree?.verifying, 25000);
		const start = Date.now(), requestId = randomUUID();
		send({ type: "prompt", requestId, text: "/ask " + (arm === "C" ? "--graph " : "") + question });
		await wait(() => transport.stats.capped || (replies.has(requestId) && state.messages.some(m => m.role === "assistant") && !state.isStreaming && state.messages.at(-1)?.role === "assistant" && state.messages.at(-1)?.stopReason !== "toolUse"), 210000);
		const duration = Date.now() - start;
		const last = state.messages.at(-1), answer = last?.role === "assistant" ? last.content?.filter(b => b.type === "text").map(b => b.text).join("\n") ?? "" : "";
		const readLines = new Set(), readFiles = new Set(), firstReads = [];
		let totalReadLines = 0;
		const sourceNames = new Map(Object.keys(manifest).map(id => ["repository:" + sha(JSON.stringify(["repository", join(root, id)])), id]));
		const calls = state.messages.flatMap(m => (m.content ?? []).filter(b => b.type === "toolCall").map(b => {
			let params = {}; try { params = JSON.parse(b.argumentsText ?? "{}"); } catch {}
			const returned = state.messages.find(r => r.role === "toolResult" && r.toolCallId === b.id);
			const key = sourceNames.get(params.sourceId) + "/" + params.path;
			if (b.name === "source_read" && returned && !returned.isError && hashes[key]) {
				const text = returned.content.filter(c => c.type === "text").map(c => c.text).join("\n");
				if (text.includes("SHA-256 " + hashes[key])) {
					readFiles.add(key);
					const data = readFileSync(join(root, key), "utf8").split(/\r?\n/);
					for (const row of text.split("\n")) {
						if (!row.startsWith(params.path + ":")) continue;
						const m = /^(\d+): (.*)$/.exec(row.slice(params.path.length + 1));
						if (!m || data[Number(m[1]) - 1] !== m[2]) continue;
						totalReadLines++; readLines.add(key + ":" + m[1]);
						if (expected[key]?.includes(Number(m[1]))) firstReads.push(observed.get(b.id) - start);
					}
				}
			}
			return { name: b.name, path: params.path, ok: returned ? !returned.isError : null };
		}));
		const evidence = [];
		for (const match of answer.matchAll(/\[[^\]]*\]\(#pi-evidence=(ev_[a-f0-9]{32})\)/g)) {
			const id = randomUUID();
			send({type:"read_file",cwd:join(root,"harness"),conversationId:state.conversationId,path:"",evidenceId:match[1],requestId:id});
			await wait(() => replies.has(id),5000);
			const file = replies.get(id).evidence, key = file && file.sourceName + "/" + file.path;
			if (!file || !hashes[key] || file.fingerprint !== hashes[key] || file.requestId !== requestId) continue;
			const read = state.messages.find(m => m.toolName === "source_read" && !m.isError && JSON.stringify(m.content).includes(match[1]));
			evidence.push({ key, start: file.startLine, end: file.endLine, sourceRead: !!read, atMs: read ? observed.get(read.toolCallId) - start : null });
		}
		const covered = new Set(), observedAt = [];
		for (const [key, lines] of Object.entries(expected)) for (const line of lines) {
			const hits = evidence.filter(e => e.sourceRead && e.key === key && e.start <= line && e.end >= line);
			if (hits.length) { covered.add(key + ":" + line); observedAt.push(...hits.map(h => h.atMs)); }
		}
		assert(transport.stats.skillVerified,"Selected skill was not expanded");
		assert.equal(transport.stats.tools.includes("graph_search"), arm === "C");
		const { input, output, cacheRead, cacheWrite, metered, ...provider } = transport.stats;
		const native = state.messages.filter(m => m.role === "assistant" && m.usage);
		const usage = metered === provider.calls ? {input,output,cacheRead,cacheWrite}
			: native.length === provider.calls ? Object.fromEntries(["input","output","cacheRead","cacheWrite"].map(key => [key,native.reduce((sum,m) => sum + m.usage[key],0)])) : null;
		return { arm, model: modelId, skillHash: sha(skillBytes), durationMs: duration, provider: { ...provider, usage, meteredViaRelay:metered, meteredParentMessages:native.length }, calls,
			firstSupportingReadMs: firstReads.length ? Math.min(...firstReads) : null, distinctFilesRead:readFiles.size,
			totalLinesRead:totalReadLines, repeatedLines:totalReadLines-readLines.size, unsuccessfulSourceCalls:calls.filter(c => c.name.startsWith("source_") && c.ok===false).length,
			firstCitedSupportingReadMs: observedAt.length ? Math.min(...observedAt) : null, coveredAnchors: covered.size, totalAnchors: 8, evidence, answer };
	} finally {
		ws?.terminate();
		await harness?.stop();
		await transport?.close();
		rmSync(root, {recursive:true,force:true});
	}
}

for (const arm of arms) {
	try { const row = await run(arm); console.log(JSON.stringify(row)); }
	catch (error) { console.log(JSON.stringify({ arm, model:modelId, failed:true, error:String(error.message).slice(0,400) })); process.exitCode = 1; }
}
