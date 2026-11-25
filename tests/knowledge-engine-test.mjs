import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { pathToFileURL } from "node:url";
const packageRoot = resolve(process.argv.includes("--package") ? process.argv[process.argv.indexOf("--package") + 1] : ".");
const executable = process.argv.includes("--executable") ? process.argv[process.argv.indexOf("--executable") + 1] : process.execPath;
const packagedModule = name => import(pathToFileURL(join(packageRoot, "dist/server", name)).href);
const { PROTOCOL_VERSION } = await packagedModule("protocol-version.js");
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-knowledge-engine-")));
const repoA = join(root, "repo-a"), repoB = join(root, "repo-b"), library = join(root, "library"), outside = join(root, "outside");
const agent = join(root, "agent"), data = join(root, "data"), home = join(root, "home");
for (const path of [repoA, repoB, library, outside, agent, data, home]) mkdirSync(path, { recursive: true });
mkdirSync(join(library, "Database"), { recursive: true });
mkdirSync(join(repoA, "src"), { recursive: true });
writeFileSync(join(repoA, "src/answer.ts"), "export const current = true;\nexport const evidence = 42;\n");
writeFileSync(join(repoB, "control.ts"), "export const control = true;\n");
writeFileSync(join(library, "history.md"), "# Historical note\n");
writeFileSync(join(data, "knowledge-library.json"), JSON.stringify({ cwd: library, path: "history.md" }));
writeFileSync(join(data, "project-workspaces.json"), JSON.stringify({ revision: 0, workspaces: [{ id: "workspace-a", name: "Workspace A", paths: [repoA, repoB] }] }));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture" } }));

let child, harness, modelPort, calls = 0, logs = "";
const requests = [], scripted = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const model = createServer(async (req, res) => {
	let raw = "";
	for await (const part of req) raw += part;
	let request;
	try { request = JSON.parse(raw); }
	catch (error) {
		console.error("model-json-error", error, raw.slice(0, 1000), raw.slice(-1000));
		res.writeHead(500).end(); return;
	}
	requests.push(request); calls++;
	const script = scripted.shift();
	const delta = script ? script(request) : { content: "done" };
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [choice] })}\n\n`);
	res.end("data: [DONE]\n\n");
});
const tool = (name, args) => () => ({ tool_calls: [{ index: 0, id: `knowledge-${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const lastEvidence = request => [...JSON.stringify(request.messages).matchAll(/evidenceId (ev_[a-f0-9]+)/g)].at(-1)?.[1];
async function wait(check, label) {
	for (let i = 0; i < 600; i++) { if (await check()) return; if (child?.exitCode != null) throw Error(logs); await sleep(50); }
	throw Error(`Timeout: ${label}\n${logs}`);
}
async function connect(id, wikiCwd) {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`), client = { ws, state: undefined, wire: [], send: message => ws.send(JSON.stringify(message)) };
	ws.on("message", raw => {
		const message = JSON.parse(raw); client.wire.push(message);
		if (message.type === "snapshot") client.state = message.state;
		if (message.type === "snapshot_delta" && client.state) client.state = { ...client.state, ...message.state, messages: [...client.state.messages, ...(message.appended ?? [])] };
	});
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	client.send({ type: "hello", clientId: id, protocolVersion: PROTOCOL_VERSION, ...(wikiCwd ? { wikiCwd } : {}) });
	await wait(() => client.state && !client.state.tree?.verifying, "initial snapshot");
	return client;
}
async function prompt(client, text, requestId, expectedCalls) {
	const before = calls;
	client.send({ type: "prompt", text, requestId });
	await wait(() => calls >= before + expectedCalls && !client.state.isStreaming, `${text} calls=${calls} wire=${JSON.stringify(client.wire.slice(-12))}`);
	return before;
}
async function promptWithConfirm(client, text, requestId, approve) {
	const before = calls, wireStart = client.wire.length;
	client.send({ type: "prompt", text, requestId });
	await wait(() => client.wire.slice(wireStart).some(message => message.type === "dialog"), `${text} confirmation`);
	const dialog = client.wire.slice(wireStart).find(message => message.type === "dialog");
	client.send({ type: "dialog_response", conversationId: client.state.conversationId, id: dialog.id, value: approve });
	await wait(() => calls >= before + 3 && !client.state.isStreaming, `${text} after confirmation`);
	return dialog;
}
async function startHarness() {
	harness = await startIsolatedHarness({
		args: [join(packageRoot, "dist/server/index.js")], executable,
		env: { ELECTRON_RUN_AS_NODE: "1", PI_WEB_PKG_ROOT: packageRoot, PI_WEB_TOKEN: "", PI_WEB_CWD: repoA, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent, HOME: home, USERPROFILE: home },
		onOutput: value => { logs = (logs + value).slice(-16000); },
	});
	child = harness.child;
}

try {
	modelPort = await listenIsolated(model);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "fixture", models: [{ id: "fixture", input: ["text"], contextWindow: 64000, maxTokens: 8000 }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultTools: ["+codemode", "+tool_search"], retry: { enabled: false }, compaction: { enabled: false } }));
	await startHarness();
	const client = await connect("knowledge-a");
	let sourceId, citationId;
	scripted.push(tool("knowledge_sources", {}), request => {
		const messages = request.messages;
		const result = messages.findLast(message => message.role === "tool" || message.role === "toolResult");
		const text = typeof result?.content === "string" ? result.content : result?.content?.map(part => part.text ?? "").join("\n");
		const sources = JSON.parse(text).sources;
		sourceId = sources.find(source => source.kind === "repository" && source.name === "repo-a").id;
		return tool("source_search", { sourceId, query: "export const evidence" })(request);
	}, request => {
		assert.match(JSON.stringify(request.messages.at(-1)), /src\/answer\.ts:2/);
		return tool("source_read", { sourceId, path: "src/answer.ts", startLine: 1, limit: 2 })(request);
	}, request => {
		const text = JSON.stringify(request.messages);
		const evidence = [...text.matchAll(/evidenceId (ev_[a-f0-9]+)/g)].at(-1)?.[1];
		assert(evidence, "source_read returned an evidence ID");
		citationId = evidence;
		return { content: `当前实现使用证据。[repo-a/src/answer.ts:2](#pi-evidence=${evidence})` };
	});
	await prompt(client, "/skill:ask 当前实现是什么？", "ask-direct", 4);
	const declared = requests[0].tools.map(item => item.function.name).sort();
	assert.deepEqual(declared, ["knowledge_investigate", "knowledge_sources", "source_list", "source_read", "source_search"]);
	assert(client.state.messages.some(message => JSON.stringify(message).includes("#pi-evidence=ev_")));

	scripted.push(tool("write", { path: "forbidden.txt", content: "not allowed" }));
	await prompt(client, "/ask 修改 forbidden.txt", "ask-write", 1);
	assert(!existsSync(join(repoA, "forbidden.txt")));
	const blocked = client.state.messages.findLast(message => message.role === "toolResult");
	assert.equal(blocked?.isError, true);
	assert.equal(blocked?.content?.[0]?.text, "Tool write not found");

	await prompt(client, "普通对话", "normal-after-ask", 1);
	const normal = requests.at(-1).tools.map(item => item.function.name);
	assert(normal.includes("write") && normal.includes("bash"), JSON.stringify(normal));
	assert(!normal.includes("knowledge_write") && !normal.includes("source_read"));
	console.log("PASS direct Ask, evidence IDs, write blocking and ordinary tool restoration");
	const learner = await connect("knowledge-learn");
	// A new client resumes this project's latest native session, which the Ask client still owns.
	const resumedConversation = learner.state.conversationId;
	learner.send({ type: "new_chat" });
	await wait(() => learner.state.conversationId !== resumedConversation && !learner.state.tree?.verifying, "independent Learn conversation");

	scripted.push(() => ({ content: "learn hello" }));
	await prompt(learner, "/skill:learn 简单学习", "learn-hello", 1);
	assert.match(JSON.stringify(learner.state.messages.at(-1)), /learn hello/);

	const learnRead = tool("source_read", { sourceId, path: "src/answer.ts", startLine: 1, limit: 2 });
	const learnWrite = request => {
		const evidence = lastEvidence(request);
		assert(evidence, "Learn source evidence exists");
		return tool("knowledge_write", {
			path: "Database/1032-error.md",
			title: "MySQL 复制 1032 异常",
			type: "troubleshooting",
			tags: ["mysql", "replication"],
			status: "verified",
			evidenceIds: [evidence],
			text: "---\ntitle: MySQL 复制 1032 异常\ntype: troubleshooting\ntags: [mysql, replication]\nstatus: verified\n---\n# MySQL 复制 1032 异常\n\n需要结合失败事件和实际数据确认根因。\n",
		})(request);
	};
	scripted.push(learnRead, learnWrite);
	const approval = await promptWithConfirm(learner, "/skill:learn 沉淀本次排障知识", "learn-create", true);
	assert.match(approval.args[0], /Database\/1032-error\.md/);
	assert.match(approval.args[0], /失败事件/);
	const documentPath = join(library, "Database/1032-error.md"), saved = readFileSync(documentPath, "utf8");
	assert.match(saved, /title: "MySQL 复制 1032 异常"/);
	assert.match(saved, /status: "verified"/);
	assert.match(saved, /session: /);
	assert.match(saved, /sourceId: "repository:/);
	assert.match(saved, /lines: "1-2"/);
	assert.match(saved, /workingTree: "unknown"/);
	assert.match(saved, /updated: \d{4}-\d{2}-\d{2}/);

	scripted.push(learnRead, learnWrite);
	const dialogsBefore = learner.wire.filter(message => message.type === "dialog").length;
	await prompt(learner, "/learn 再次沉淀同一知识", "learn-duplicate", 3);
	assert.equal(learner.wire.filter(message => message.type === "dialog").length, dialogsBefore);
	const duplicate = learner.state.messages.findLast(message => message.role === "toolResult" && message.toolName === "knowledge_write");
	assert.equal(JSON.parse(duplicate.content[0].text).status, "unchanged");
	const { WikiService } = await packagedModule("wiki-service.js");
	const revisions = (await new WikiService(join(data, "wiki")).state(library)).revisions;
	assert.equal(revisions.length, 1);
	assert.equal(revisions[0].author, "pi");
	assert.equal(revisions[0].requestId, "learn-create");

	const updatedText = saved.replace("需要结合失败事件和实际数据确认根因。", "先检查主键和主备数据差异。");
	scripted.push(learnRead, request => {
		const evidence = lastEvidence(request);
		return tool("knowledge_write", { path: "Database/1032-error.md", expectedVersion: "stale-version", evidenceIds: [evidence], text: updatedText })(request);
	});
	await prompt(learner, "/learn 更新排障知识", "learn-stale", 2);
	assert.equal(readFileSync(documentPath, "utf8"), saved);

	const currentVersion = (await import("node:crypto")).createHash("sha256").update(saved).digest("hex");
	scripted.push(learnRead, request => {
		const evidence = lastEvidence(request);
		return tool("knowledge_write", { path: "Database/1032-error.md", expectedVersion: currentVersion, evidenceIds: [evidence], text: updatedText })(request);
	});
	await promptWithConfirm(learner, "/learn 取消本次修改", "learn-cancel", false);
	assert.equal(readFileSync(documentPath, "utf8"), saved);
	console.log("PASS Learn approval, provenance, duplicate skip, stale CAS and cancellation");
	if (process.argv.includes("--browser")) await (await import("./lib/knowledge-browser.mjs")).verifyKnowledgeBrowser({port: harness.port, scripted, tool, repoA, repoB, library});
	await prompt(client, "/ask 保存会话前再次查证", "ask-before-restart", 1);
	const savedSession = client.state.sessionFile;
	client.ws.terminate();
	learner.ws.terminate();
	await harness.stop();
	await startHarness();
	const restored = await connect("knowledge-restored");
	if (restored.state.sessionFile !== savedSession) {
		restored.send({type: "switch_session", path: savedSession});
		await wait(() => restored.state.sessionFile === savedSession && !restored.state.tree?.verifying, "reopen native Ask session");
	}
	const preview = async (id, requestId, extra = {}) => {
		restored.send({ type: "read_file", path: "", evidenceId: id, conversationId: restored.state.conversationId, cwd: repoA, requestId, ...extra });
		await wait(() => restored.wire.some(m => m.requestId === requestId), requestId);
		return restored.wire.find(m => m.requestId === requestId);
	};
	const content = await preview(citationId, "restored-evidence", {line: 2});
	assert.equal(content.type, "file_content");
	assert.equal(content.evidence.id, citationId);
	assert.equal(content.path, "src/answer.ts");
	assert.match(content.text, /evidence = 42/);
	assert.equal((await preview("ev_" + "0".repeat(32), "forged")).errorCode, "evidence_unavailable");
	assert.equal((await preview(citationId, "wrong-owner", {conversationId: "unrelated"})).errorCode, "evidence_unavailable");
	writeFileSync(join(repoA, "src/answer.ts"), "changed after citation");
	const stale = await preview(citationId, "stale-evidence");
	assert.equal(stale.errorCode, "stale_evidence");
	assert.equal(stale.text, undefined);
	await prompt(restored, "普通会话恢复后继续", "ordinary-after-restart", 1);
	const resumed = requests.at(-1).tools.map(tool => tool.function.name);
	assert(resumed.includes("bash") && resumed.includes("write") && !resumed.includes("knowledge_write"));
	restored.ws.terminate();
	console.log("PASS branch evidence after service restart, ownership and stale fingerprint");
} finally {
	for (const server of [model]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
	await harness?.stop();
	rmSync(root, { recursive: true, force: true });
}
