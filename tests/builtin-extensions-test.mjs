/** Real Web chat transport + SDK + local fixture model. --browser adds the settings UI. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../dist/server/protocol-version.js";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-builtin-chat-"))), agent = join(root, "agent"), data = join(root, "data"), home = join(root, "home");
mkdirSync(agent); mkdirSync(data); mkdirSync(home);
const personalSkill = join(agent, "skills", "personal-example", "SKILL.md");
mkdirSync(dirname(personalSkill), { recursive: true });
writeFileSync(personalSkill, "---\nname: personal-example\ndescription: Personal fixture skill\n---\nUse this fixture.\n");
process.env.PI_WEB_DATA_DIR = data;
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture" } }));
writeFileSync(join(agent, "webui-extensions.json"), JSON.stringify({ autoCheck: false }));
let child, harness, browser, logs = "", nextCode, calls = 0, port, holdNext = false, release, holdAt;
const clients = [], modelRequests = [];
const scriptedCalls = [];
const model = createServer(async (req, res) => {
	let raw = "";
	for await (const part of req) raw += part;
	modelRequests.push(JSON.parse(raw));
	calls++;
	if (holdNext || calls === holdAt) { holdNext = false; await new Promise(resolve => { release = resolve; }); }
	const code = nextCode; nextCode = undefined;
	const scripted = scriptedCalls.shift();
	const delta = scripted ? { tool_calls: [{ index: 0, id: `bg-${calls}`, type: "function", function: { name: scripted.name, arguments: JSON.stringify(scripted.args) } }] } : code ? { tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name: "codemode", arguments: JSON.stringify({ code }) } }] } : { content: "Local document verification completed." };
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: code || scripted ? "tool_calls" : "stop" }]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [choice] })}\n\n`);
	res.end("data: [DONE]\n\n");
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, label) {
	for (let i = 0; i < 1000; i++) { if (await check()) return; if (child?.exitCode != null) throw Error(logs); await sleep(50); }
	throw Error(`Timeout: ${label}\n${logs}`);
}
async function connect(id, wiki = false) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const client = { id, ws, state: undefined, wire: [], send: message => ws.send(JSON.stringify(message)) }; clients.push(client);
	// Exercise delayed snapshots: model completion must never expose a previous turn as settled.
	ws.on("message", raw => setTimeout(() => {
		const message = JSON.parse(raw); client.wire.push(message);
		if (message.type === "snapshot") client.state = message.state;
		if (message.type === "snapshot_delta" && client.state) client.state = { ...client.state, ...message.state, messages: [...client.state.messages, ...(message.appended ?? [])] };
	}, 200));
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	client.send({ type: "hello", clientId: id, protocolVersion: PROTOCOL_VERSION, ...(wiki ? { wikiCwd: root } : {}) });
	await wait(() => client.state && !client.state.tree?.verifying, "initial snapshot");
	return client;
}
async function request(client, action, extra = {}, expectedStatus = 200) {
	const response = await fetch(`http://127.0.0.1:${port}/api/extensions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: client.id, cwd: root, conversationId: client.state.conversationId, action, ...extra }) });
	const value = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(value)); return value;
}
const item = (state, id) => state.items.find(item => item.id === id);
async function toggle(client, id, enabled) {
	const state = await request(client, "builtin-list");
	return request(client, "builtin-toggle", { id, enabled, version: item(state, id)?.settingsVersion ?? state.documentVersion });
}
async function prompt(client, text, code) {
	nextCode = code; const before = calls;
	client.send({ type: "prompt", text, requestId: `fixture-${before}` });
	// Model HTTP completion can precede the throttled WebSocket snapshot.
	await wait(() => calls >= before + 2 && !client.state.isStreaming &&
		client.state.messages.some(message => message.role === "toolResult" && message.toolCallId === `call-${before + 1}`), text);
	assert.equal(calls, before + 2, "one requested tool turn and one final answer");
}
async function verifyBackgroundCommands(a, b) {
	writeFileSync(join(root, "independent.txt"), "independent read succeeded");
	const start = calls;
	const script = "require('fs').appendFileSync('starts','1');const t=setInterval(()=>{if(require('fs').existsSync('finish')){clearInterval(t);console.log('finished')}},50)";
	scriptedCalls.push({ name: "bash", args: { command: 'node -e "' + script + '"', timeout: 48 } }, { name: "read", args: { path: "independent.txt" } });
	a.send({ type: "prompt", text: "Start slow test and read independent.txt", requestId: "slow-test" });
	await wait(() => a.state.backgroundCommands?.some(t => t.state === "background") && !a.state.isStreaming && a.state.messages.some(m => m.role === "toolResult" && m.toolName === "read" && JSON.stringify(m.content).includes("independent read succeeded")), "same agent reads during silent background test");
	const running = a.state.backgroundCommands.find(t => t.state === "background");
	assert.equal(running.output, "");
	const report = name => JSON.parse(a.state.messages.findLast(m => m.role === "toolResult" && m.toolName === name).content[0].text);
	assert.equal(report("bash").willNotify, true);
	assert.match(report("bash").note, /do not poll/i);
	const recoveryDir = join(root, "recovery");
	mkdirSync(recoveryDir);
	// Resume a copy of the on-disk session as it existed before process exit.
	const { SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { backgroundBash, commandViews } = await import("../dist/server/background-bash.js");
	const copy = join(recoveryDir, "interrupted.jsonl");
	writeFileSync(copy, readFileSync(a.state.sessionFile));
	const recovered = SessionManager.open(copy);
	const handlers = new Map();
	backgroundBash(recovered, SettingsManager.inMemory(), () => {}, () => {})({
		registerTool() {}, on(name, handler) { handlers.set(name, handler); },
	});
	await handlers.get("session_start")();
	assert.equal(commandViews(recovered).find(t => t.id === running.id)?.state, "interrupted");
	await handlers.get("session_shutdown")();
	assert.equal(running.detachedAt - running.startedAt >= 29900, true);
	const beforeFollowup = calls;
	scriptedCalls.push({ name: "bash_task", args: { action: "read", id: running.id, cursor: 0 } });
	a.send({ type: "prompt", text: "How is the search progressing?", requestId: "background-progress" });
	await wait(() => calls === beforeFollowup + 2 && !a.state.isStreaming && a.state.messages.some(m => m.role === "toolResult" && m.toolName === "bash_task"), "follow-up reads silent command");
	const progress = report("bash_task");
	assert.equal(progress.unchanged, true);
	assert.equal(progress.lastOutputAtMs, null);
	assert(progress.elapsedMs >= 29900 && progress.willNotify);
	writeFileSync(join(root, "finish"), "");
	await wait(() => a.state.backgroundCommands.some(t => t.id === running.id && t.exitCode === 0), "command completed after follow-up");
	await wait(() => calls >= beforeFollowup + 3 && !a.state.isStreaming, "automatic completion after another user message");
	assert.equal(readFileSync(join(root, "starts"), "utf8"), "1");
	assert.equal(calls, start + 6);
	const entries = readFileSync(a.state.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
	const delivered = entries.filter(e => e.type === "custom_message" && e.customType === "background-results")
		.flatMap(e => JSON.parse(e.content)).filter(t => t.id === running.id);
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0].originatingUserEntryId, entries.find(e => e.type === "message" && e.message.role === "user").id);
	assert.match(delivered[0].output, /finished/);
	assert(delivered[0].lastOutputAtMs >= running.startedAt);
	assert.equal(b.state.backgroundCommands?.length ?? 0, 0);
	a.send({ type: "trace_get", reqId: "background-trace", conversationId: a.state.conversationId });
	await wait(() => a.wire.some(m => m.type === "trace_result" && m.reqId === "background-trace"), "background trace");
	const traceRun = a.wire.find(m => m.reqId === "background-trace").trace.runs.find(r => r.backgroundSpans?.some(s => s.id === running.id));
	assert(traceRun);
	const span = traceRun.backgroundSpans.find(s => s.id === running.id);
	assert(span.endMs > span.startMs && span.state === "done");
	assert(traceRun.tools.some(t => t.toolName === "read" && t.startMs >= span.startMs && t.endMs <= span.endMs));
	assert(!JSON.stringify(span).includes("finished"));
	const control = (id, action) => a.send({ type: "background_command", conversationId: a.state.conversationId, sessionId: a.state.sessionId, id, action });
	const longCommand = 'node -e "setInterval(()=>{},1000)"';
	scriptedCalls.push({ name: "bash", args: { command: longCommand, timeout: 15 } });
	a.send({ type: "prompt", text: "Manual detach", requestId: "manual-detach" });
	await wait(() => a.state.backgroundCommands.some(t => t.state === "foreground"), "manual foreground");
	const manual = a.state.backgroundCommands.find(t => t.state === "foreground").id;
	control(manual, "detach");
	await wait(() => !a.state.isStreaming && a.state.backgroundCommands.some(t => t.id === manual && t.state === "background"), "manual detach");
	const beforeStop = calls;
	control(manual, "stop");
	await wait(() => a.state.backgroundCommands.some(t => t.id === manual && t.state === "stopped"), "manual stop");
	await sleep(250);
	assert.equal(calls, beforeStop, "stopped process does not wake model");
	scriptedCalls.push({ name: "bash", args: { command: longCommand, background: true, timeout: 1 } });
	a.send({ type: "prompt", text: "Timeout in background", requestId: "background-timeout" });
	await wait(() => a.state.backgroundCommands.some(t => t.state === "failed" && /timed out/.test(t.error)) && !a.state.isStreaming && calls === beforeStop + 3, "explicit background timeout");
	const stopStart = calls;
	const stopId = `bg-${stopStart + 1}`;
	scriptedCalls.push({ name: "bash", args: { command: longCommand, background: true, timeout: 15 } },
		{ name: "bash_task", args: { action: "stop", id: stopId } });
	a.send({ type: "prompt", text: "Cancel the background task", requestId: "tool-stop" });
	await wait(() => calls === stopStart + 3 && !a.state.isStreaming && a.state.messages.some(m => m.role === "toolResult" && m.toolCallId === `bg-${stopStart + 2}`), "stop tool response");
	assert.equal(report("bash_task").state, "stopped");
	assert.equal(report("bash_task").willNotify, false);
	for (const consume of [false, true]) {
		const before = calls;
		const gate = `finish-${consume}`;
		const program = `const t=setInterval(()=>{if(require('fs').existsSync('${gate}')){clearInterval(t);console.log('gate complete')}},50)`;
		const command = 'node -e "' + program + '"';
		scriptedCalls.push({ name: "bash", args: { command, background: true, timeout: 15 } });
		// Hold the second provider call open while the process finishes.
		const id = `bg-${before + 1}`;
		holdAt = before + 2;
		a.send({ type: "prompt", text: gate, requestId: gate });
		await wait(() => calls === before + 2 && release && a.state.backgroundCommands.some(t => t.id === id && t.state === "background"), "busy provider");
		if (consume) scriptedCalls.push({ name: "bash_task", args: { action: "read", id } });
		writeFileSync(join(root, gate), "");
		await wait(() => a.state.backgroundCommands.some(t => t.id === id && t.exitCode === 0), "completed during provider request");
		release(); release = undefined;
		await wait(() => calls === before + 3 && !a.state.isStreaming, "single next model request");
		if (consume) assert(a.state.messages.some(m => m.role === "toolResult" && m.toolName === "bash_task" && JSON.stringify(m.content).includes("gate complete")));
		await sleep(250);
		assert.equal(calls, before + 3);
	}
	for (const enabled of [false, true]) {
		await toggle(a, "background-bash", enabled);
		a.send({ type: "extensions_reload" });
		await wait(async () => item(await request(a, "builtin-list"), "background-bash").status === (enabled ? "loaded" : "disabled"), "reload bash");
		await prompt(a, "Nested bash returns final exit code", 'text((await tools.bash({command:"exit 7"})).exit_code)');
		assert.match(JSON.stringify(a.state.messages.findLast(m => m.role === "toolResult").content), /7/);
	}
	console.log("PASS automatic and manual background execution, recovery, completion delivery, trace and native Bash compatibility");
}

const supportsDesktop = ["darwin", "win32"].includes(process.platform);
const inventoryCount = supportsDesktop ? 5 : 4;
const fakeBin = join(root, "fake-bin"), npxCalls = join(root, "npx-calls");
const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "PATH";
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, process.platform === "win32" ? "npx.cmd" : "npx"), process.platform === "win32"
	? `@echo off\r\n>>"${npxCalls}" echo called\r\nexit /b 1\r\n`
	: `#!/bin/sh\nprintf 'called\\n' >> ${JSON.stringify(npxCalls)}\nexit 1\n`, { mode: 0o755 });
try {
	// Simulate upgrading a user who enabled the old bridge before opening chat.
	writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { playwright_extension: { command: "npx", args: ["--version"] } } }));
	await listenIsolated(model);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${model.address().port}`, apiKey: "fixture", models: [{ id: "fixture", input: ["text"], contextWindow: 64000, maxTokens: 8000 }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultTools: ["+codemode", "+tool_search"], retry: { enabled: false }, compaction: { enabled: false } }));
	harness = await startIsolatedHarness({ env: { PI_WEB_TOKEN: "", PI_WEB_CWD: root, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent, HOME: home, USERPROFILE: home, [pathKey]: `${fakeBin}${delimiter}${process.env[pathKey] ?? ""}` }, onOutput: value => { logs = (logs + value).slice(-16000); } });
	child = harness.child; port = harness.port;
	const a = await connect("builtin-a"), b = await connect("builtin-b");
	const wiki = await connect("builtin-wiki", true);
	for (const command of ["/reload", "/restart"]) {
		const requestId = `wiki-reload-${command.slice(1)}`;
		wiki.send({ type: "prompt", text: command, requestId });
		await wait(() => wiki.wire.some(message => message.type === "prompt_result" && message.requestId === requestId), `Wiki ${command} receipt`);
		assert.equal(wiki.wire.find(message => message.type === "prompt_result" && message.requestId === requestId).ok, true);
	}
	const state = await request(a, "builtin-list"); assert.equal(state.items.length, inventoryCount);
	assert.equal(item(state, "background-bash").status, "loaded");
	assert.equal(item(await request(wiki, "builtin-list"), "background-bash"), undefined);
	if (process.argv.includes("--background")) await verifyBackgroundCommands(a, b);
	assert.equal(item(state, "pi-harness-subagents"), undefined);
	assert.match((await request(a, "builtin-toggle", { id: "pi-harness-subagents", enabled: true, version: state.documentVersion }, 400)).error, /Invalid/);
	if (supportsDesktop) {
		// New conversations are pre-authorized by the service-wide default; a single conversation can still revoke it.
		// (`state` is the initial snapshot, so it shows the value used when this conversation was created.)
		assert.equal(item(state, "desktop-control").desktopDefault, true);
		assert.equal(item(state, "desktop-control").enabled, true);
		await toggle(a, "desktop-control", false);
		assert.equal(item(await request(a, "builtin-list"), "desktop-control").enabled, false);
		assert.equal(item(await request(b, "builtin-list"), "desktop-control").enabled, true);
		await prompt(a, "Check desktop tool revoke", 'text(await tools.desktop_window({action:"view"}));');
		assert.match(JSON.stringify(a.state.messages.findLast(message => message.role === "toolResult")), /Enable desktop control/);
		await toggle(a, "desktop-control", true);
		assert.equal(item(await request(a, "builtin-list"), "desktop-control").enabled, true);
		await prompt(a, "Check desktop tool grant", 'text(await tools.desktop_window({action:"view"}));');
		assert.match(JSON.stringify(a.state.messages.findLast(message => message.role === "toolResult")), /Select a window id/);
		// Service-wide default: saved in document settings, applies to conversations started afterwards only.
		const settings = await request(a, "builtin-list");
		await request(a, "builtin-toggle", { id: "desktop-control", enabled: false, version: settings.documentVersion });
		const disabledByDefault = item(await request(a, "builtin-list"), "desktop-control");
		assert.equal(disabledByDefault.desktopDefault, false);
		assert.equal(disabledByDefault.enabled, true);
		assert.equal(item(await request(b, "builtin-list"), "desktop-control").desktopDefault, false);
		assert.equal(JSON.parse(readFileSync(join(data, "document-extensions.json"), "utf8")).desktopDefaultEnabled, false);
		const beforeDefault = a.state.conversationId; a.send({ type: "new_chat", fresh: true });
		await wait(() => a.state.conversationId !== beforeDefault && !a.state.tree?.verifying, "new chat with desktop default off");
		await wait(async () => item(await request(a, "builtin-list"), "desktop-control").enabled === false, "desktop default opt-out applies to the new chat");
		await prompt(a, "Check desktop default opt-out", 'text(await tools.desktop_window({action:"view"}));');
		assert.match(JSON.stringify(a.state.messages.findLast(message => message.role === "toolResult")), /Enable desktop control/);
		const restored = await request(a, "builtin-list");
		await request(a, "builtin-toggle", { id: "desktop-control", enabled: true, version: restored.documentVersion });
		assert.equal(item(await request(a, "builtin-list"), "desktop-control").desktopDefault, true);
	}
	assert.equal(item(state, "pi-harness-pdf-markdown"), undefined);
	assert.match((await request(a, "builtin-toggle", { id: "pi-harness-pdf-markdown", enabled: true, version: state.documentVersion }, 400)).error, /Invalid/);
	assert.equal(item(state, "pi-harness-database"), undefined);
	assert.equal(item(state, "codemode").status, "loaded");
	assert.equal(item(state, "tool-search").status, "loaded");
	assert.equal((await request(a, "list")).packages.length, 0);
	assert.match((await request(a, "builtin-list", { conversationId: "stale" }, 400)).error, /Conversation changed/);
	assert.match((await request(a, "builtin-toggle", { id: "mcp", enabled: false, version: state.documentVersion }, 400)).error, /Invalid/);
	a.send({ type: "get_commands" });
	await wait(() => a.wire.some(message => message.type === "slash_commands"), "slash commands");
	const commands = a.wire.findLast(message => message.type === "slash_commands").commands;
	assert(commands.some(command => command.name === "skill:personal-example" && command.source === "skill"), "personal skills remain available");
	const engineeringNames = ["engineering", "knowledge-sync", "grilling", "domain-modeling", "codebase-design", "tdd", "architect", "blast-radius", "reflect", "learn", "ask"];
	for (const name of engineeringNames) assert(commands.some(command => command.name === `skill:${name}` && command.source === "skill"), `${name} in native command catalog`);
	for (const name of ["skill:design-first", "skill:bug-fix", "skill:feat"]) assert(!commands.some(command => command.name === name), `${name} retired from bundled catalog`);
	const wikiCommandStart = wiki.wire.length;
	wiki.send({ type: "get_commands" });
	await wait(() => wiki.wire.slice(wikiCommandStart).some(message => message.type === "slash_commands"), "Wiki slash commands");
	const wikiCommands = wiki.wire.slice(wikiCommandStart).find(message => message.type === "slash_commands").commands;
	for (const name of engineeringNames) assert(!wikiCommands.some(command => command.name === `skill:${name}`), `${name} excluded from Wiki`);
	for (const name of ["ask", "learn"]) {
		assert(commands.some(command => command.name === name));
		assert(!wikiCommands.some(command => command.name === name));
	}
	let before = calls;
	a.send({ type: "prompt", text: "Native baseline", requestId: "native-baseline" });
	await wait(() => calls === before + 1 && !a.state.isStreaming, "native baseline request");
	const baselineRequest = modelRequests.at(-1);
	const baselineSystem = baselineRequest.messages.find(message => message.role === "system");
	assert.match(typeof baselineSystem?.content === "string" ? baselineSystem.content : "", /load the engineering skill if available/, "normal session prompt carries the routing rule");
	before = calls;
	a.send({ type: "prompt", text: "/skill:engineering Preserve $1 and spaces", requestId: "engineering-expansion" });
	await wait(() => calls === before + 1 && !a.state.isStreaming, "Engineering Skill expansion");
	const expandedRequest = modelRequests.at(-1), expandedUser = expandedRequest.messages.findLast(message => message.role === "user");
	const expandedText = typeof expandedUser.content === "string" ? expandedUser.content : expandedUser.content.map(part => part.text ?? "").join("\n");
	assert.match(expandedText, /Deliver working software with the lightest workflow/);
	assert.match(expandedText, /Preserve \$1 and spaces/);
	assert(expandedText.includes(join(process.cwd(), "assets/skills/engineering/SKILL.md")), "expanded Skill uses the bundled absolute path");
	assert.equal(expandedRequest.model, baselineRequest.model, "Skill invocation preserves the selected model");
	assert.deepEqual(expandedRequest.tools, baselineRequest.tools, "Skill invocation preserves native tools");
	console.log("PASS thirteen bundled Skills, isolated Wiki resources, native expansion, model and tool compatibility");
	assert(!commands.some(command => ["documents", "pdf-md", "okf"].includes(command.name)), "conversion and OKF commands removed");
	mkdirSync(join(agent, "extensions"), { recursive: true });
	const bashOverride = join(agent, "extensions", "bash-conflict.ts");
	writeFileSync(bashOverride, `export default pi => pi.registerTool({ name: "bash", label: "User bash", description: "User bash", parameters: { type: "object", properties: {command: {type:"string"}} }, execute: async () => ({content: [{type:"text",text:"user-owned bash"}],details:{}}) });`);
	a.send({ type: "extensions_reload" });
	await wait(async () => item(await request(a, "builtin-list"), "background-bash").reason === "conflict", "user Bash override takes precedence");
	rmSync(bashOverride);
	a.send({ type: "extensions_reload" });
	await wait(async () => item(await request(a, "builtin-list"), "background-bash").status === "loaded", "Bash restored");
	await prompt(a, "Check removed tools", 'text(["document_to_markdown", "okf_ingest", "database_read"].some(name => name in tools));');
	assert.match(JSON.stringify(a.state.messages.findLast(message => message.role === "toolResult")), /false/);
	assert.match((await request(a, "builtin-toggle", { id: "pi-harness-database", enabled: true, version: state.documentVersion }, 400)).error, /Invalid/);
	holdNext = true;
	a.send({ type: "prompt", text: "Hold the fixture turn", requestId: "busy-check" });
	await wait(() => release && a.state.isStreaming, "running fixture");
	assert.equal((await request(a, "builtin-list")).canReload, false);
	release(); release = undefined;
	await wait(() => !a.state.isStreaming, "settled fixture");
	const old = a.state.conversationId; a.send({ type: "new_chat", fresh: true });
	await wait(() => a.state.conversationId !== old && !a.state.tree?.verifying, "new chat");
	assert.equal(item(await toggle(a, "background-bash", true), "background-bash").status, "loaded");
	const saved = readFileSync(join(data, "document-extensions.json"), "utf8");
	writeFileSync(join(data, "document-extensions.json"), "broken-json");
	const broken = await request(a, "builtin-list"); assert.equal(broken.items.length, inventoryCount); assert.equal(item(broken, "background-bash").status, "error"); assert.equal(item(broken, "codemode").status, "loaded");
	writeFileSync(join(data, "document-extensions.json"), saved);
	console.log("PASS built-in inventory, removed conversion/OKF/database tools, version conflicts and new chat settings");

	assert(!existsSync(npxCalls), "retired browser MCP must never launch");
	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core"), { CHROME_PATH } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		await context.addInitScript(() => { if (!localStorage.getItem("pi-harness:lang")) localStorage.setItem("pi-harness:lang", "zh"); });
		const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15000);
		await page.goto(`http://127.0.0.1:${port}`);
		const composer = page.locator(".inputbar textarea");
		if (process.argv.includes("--background") || process.argv.includes("--background-card")) {
			scriptedCalls.push({ name: "bash", args: { command: 'node -e "setInterval(()=>{},1000)"', timeout: 40, background: true } });
			await composer.fill("Background command card");
			await composer.press("Enter");
			// Manual detach is gone: backgrounding is automatic (30s / background:true); the card shows a clickable background-task entry.
			const task = page.getByRole("button", { name: /后台任务/ }).first();
			await task.waitFor();
			assert.equal(await page.getByRole("button", { name: "转到后台", exact: true }).count(), 0);
			await task.click();
			await page.locator(".bash-row-body").first().waitFor();
			await page.reload();
			const stop = page.getByRole("button", { name: "停止命令", exact: true });
			await stop.click();
			await page.locator(".bash-row").getByText("Cancelled", {exact:true}).waitFor();
		}
		async function openSettings(en = false) {
			try { await page.getByRole("button", { name: en ? "Settings" : "设置", exact: true }).first().click(); }
			catch (error) { throw Error(`${error.message}\nPage errors: ${JSON.stringify(errors)}\nPage: ${(await page.locator("body").innerText()).slice(0, 3000)}`); }
			await page.getByText(en ? "All settings" : "所有设置", { exact: true }).click();
			await page.getByRole("button", { name: "Extensions", exact: true }).click();
			await page.locator('[data-builtin-id="codemode"]').waitFor();
		}
		await openSettings();
		const panel = page.locator(".builtin-extensions"), background = panel.locator('[data-builtin-id="background-bash"]');
		assert.equal(await panel.locator(".builtin-row").count(), inventoryCount);
		assert.equal(await panel.locator('[data-builtin-id="pi-harness-subagents"]').count(), 0);
		await page.getByRole("tab", { name: "已安装 · 0", exact: true }).waitFor();
		await background.getByRole("switch").click(); await wait(() => JSON.parse(readFileSync(join(data, "document-extensions.json"), "utf8")).backgroundEnabled === false, "browser toggle off");
		await background.getByRole("switch").click(); await wait(() => JSON.parse(readFileSync(join(data, "document-extensions.json"), "utf8")).backgroundEnabled === true, "browser toggle on");
		assert.equal(await panel.locator('[data-builtin-id="pi-harness-okf"]').count(), 0);
		assert.equal(await panel.locator('[data-builtin-id="pi-harness-pdf-markdown"]').count(), 0);
		await panel.locator('[data-builtin-id="codemode"]').getByRole("button", { name: "查看设置", exact: true }).click();
		await page.locator(".native-mcp-panel").waitFor();
		await page.getByRole("button", { name: "Extensions", exact: true }).click();
		assert.equal(await panel.getByRole("button", { name: "管理浏览器连接" }).count(), 0);
		await page.route("**/api/extensions", async route => {
			if (route.request().postDataJSON()?.action === "list") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Package fixture unavailable" }) });
			await route.continue();
		});
		await page.reload(); await openSettings(); assert.equal(await panel.locator(".builtin-row").count(), inventoryCount);
		await page.getByText("Package fixture unavailable", { exact: false }).waitFor();
		await page.unroute("**/api/extensions"); await page.reload(); await openSettings();
		mkdirSync("tests/scratch", { recursive: true });
		await page.screenshot({ path: "tests/scratch/builtin-extensions-zh.png", fullPage: true });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.evaluate(() => document.documentElement.dataset.appearance = "dark");
		assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
		await page.screenshot({ path: "tests/scratch/builtin-extensions-narrow.png", fullPage: true });
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.evaluate(() => localStorage.setItem("pi-harness:lang", "en")); await page.reload(); await openSettings(true);
		assert.equal(await panel.getByText("Document to Markdown", { exact: true }).count(), 0);
		await page.screenshot({ path: "tests/scratch/builtin-extensions-en.png", fullPage: true });
		assert.deepEqual(errors, []); assert(!existsSync(join(data, "runtimes")));
		console.log("PASS built-in browser: inventory, toggles, settings links, package failure isolation, Chinese/English and narrow layout");
	}
} finally {
	release?.();
	await browser?.close(); for (const client of clients) client.ws.terminate();
	await harness?.stop();
	model.closeAllConnections(); if (model.listening) await new Promise(resolve => model.close(resolve)); rmSync(root, { recursive: true, force: true });
}
