/** Real Web chat transport + SDK + local fixture model. --browser adds the settings UI. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-builtin-chat-"))), agent = join(root, "agent"), data = join(root, "data");
mkdirSync(agent); mkdirSync(data); mkdirSync(join(root, "raw"));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture" } }));
writeFileSync(join(agent, "webui-extensions.json"), JSON.stringify({ autoCheck: false }));
writeFileSync(join(root, "raw/policy.md"), "# Policy\n\nThe support desk operates on weekdays.\n");
let child, browser, logs = "", nextCode, calls = 0, port, holdNext = false, release;
const clients = [];
const model = createServer(async (req, res) => {
	for await (const _part of req) { /* Consume the local request, never log prompt contents. */ }
	calls++;
	if (holdNext) { holdNext = false; await new Promise(resolve => { release = resolve; }); }
	const code = nextCode; nextCode = undefined;
	const delta = code ? { tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name: "codemode", arguments: JSON.stringify({ code }) } }] } : { content: "Local document verification completed." };
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: code ? "tool_calls" : "stop" }]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [choice] })}\n\n`);
	res.end("data: [DONE]\n\n");
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, label) {
	for (let i = 0; i < 600; i++) { if (await check()) return; if (child?.exitCode != null) throw Error(logs); await sleep(50); }
	throw Error(`Timeout: ${label}\n${logs}`);
}
async function connect(id) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const client = { id, ws, state: undefined, wire: [], send: message => ws.send(JSON.stringify(message)) }; clients.push(client);
	ws.on("message", raw => {
		const message = JSON.parse(raw); client.wire.push(message);
		if (message.type === "snapshot") client.state = message.state;
		if (message.type === "snapshot_delta" && client.state) client.state = { ...client.state, ...message.state, messages: [...client.state.messages, ...(message.appended ?? [])] };
	});
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	client.send({ type: "hello", clientId: id, protocolVersion: 42 });
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
	return request(client, "builtin-toggle", { id, enabled, version: state.documentVersion });
}
async function prompt(client, text, code) {
	nextCode = code; const before = calls;
	client.send({ type: "prompt", text, requestId: `fixture-${before}` });
	await wait(() => calls >= before + 2 && !client.state.isStreaming, text);
	assert.equal(calls, before + 2, "one requested tool turn and one final answer");
}
async function reload(client) {
	client.send({ type: "extensions_reload" });
	await wait(async () => item(await request(client, "builtin-list"), "pi-harness-okf").status === "loaded", "reload");
}

try {
	await new Promise((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); }); assert(model.address().port >= 8900);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${model.address().port}`, apiKey: "fixture", models: [{ id: "fixture", input: ["text"], contextWindow: 64000, maxTokens: 8000 }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultTools: ["+codemode", "+tool_search"], retry: { enabled: false }, compaction: { enabled: false } }));
	const probe = createServer(); await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); }); port = probe.address().port; assert(port >= 8900); await new Promise(resolve => probe.close(resolve));
	child = spawn(process.execPath, ["dist/server/index.js"], { env: { ...process.env, PORT: String(port), PI_WEB_HOST: "127.0.0.1", PI_WEB_TOKEN: "", PI_WEB_CWD: root, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent }, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.on("data", value => logs += value); child.stderr.on("data", value => logs += value);
	await wait(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).pid === child.pid; } catch { return false; } }, "server health");
	const a = await connect("builtin-a"), b = await connect("builtin-b");
	const state = await request(a, "builtin-list"); assert.equal(state.items.length, 5);
	assert.equal(item(state, "pi-harness-pdf-markdown"), undefined);
	assert.match((await request(a, "builtin-toggle", { id: "pi-harness-pdf-markdown", enabled: true, version: state.documentVersion }, 400)).error, /Invalid/);
	assert.equal(item(state, "pi-harness-okf").status, "loaded");
	assert.equal(item(state, "codemode").status, "loaded");
	assert.equal(item(state, "tool-search").status, "loaded");
	assert.equal((await request(a, "list")).packages.length, 0);
	assert.match((await request(a, "builtin-list", { conversationId: "stale" }, 400)).error, /Conversation changed/);
	assert.match((await request(a, "builtin-toggle", { id: "mcp", enabled: false, version: state.documentVersion }, 400)).error, /Invalid/);
	a.send({ type: "get_commands" });
	await wait(() => a.wire.some(message => message.type === "slash_commands" && message.commands.some(command => command.name === "okf")), "OKF command");
	const commands = a.wire.findLast(message => message.type === "slash_commands").commands;
	assert(!commands.some(command => ["documents", "pdf-md"].includes(command.name)), "conversion commands removed");
	await prompt(a, "Check removed conversion tool", 'text(typeof tools.document_to_markdown);');
	assert.match(JSON.stringify(a.state.messages.findLast(message => message.role === "toolResult")), /document_to_markdown does not exist/);
	await prompt(a, "/okf ingest raw/policy.md", `const start=(await tools.okf_ingest({action:'start',paths:['raw/policy.md']})).result;
const id=start.jobId;
await tools.okf_ingest({action:'next',jobId:id});
const evidence=(await tools.okf_candidates({action:'read',jobId:id})).result;
const source=evidence.sources[0],block=source.blocks.find(b=>b.text.includes('support desk operates'));
await tools.okf_candidates({action:'submit',jobId:id,sourceId:source.sourceId,candidates:[{basis:'fact',conceptId:'support-hours',title:'Support hours',type:'Policy',statement:'The support desk operates on weekdays.',evidence:[{sourceId:source.sourceId,sourceHash:source.hash,blockId:block.id,quote:'The support desk operates on weekdays.'}],review:{support:'supported',rationale:'The single-source fixture explicitly states the policy.',comparedConceptIds:[],conflicts:[]}}]});
text(await tools.okf_publish({jobId:id}));`);
	assert.match(readFileSync(join(root, "knowledge/wiki/concepts/support-hours.md"), "utf8"), /status: draft/);
	await toggle(a, "pi-harness-okf", false);
	assert.equal(item(await request(b, "builtin-list"), "pi-harness-okf").status, "disabled");
	assert.match((await request(a, "builtin-toggle", { id: "pi-harness-okf", enabled: true, version: state.documentVersion }, 400)).error, /changed/);
	await prompt(a, "Check disabled tool", 'text(await tools.okf_ingest({action:"status"}));');
	const rejected = a.state.messages.findLast(message => message.role === "toolResult");
	assert(rejected?.isError && /disabled/.test(JSON.stringify(rejected)), "disabled tool rejects an already loaded call");
	holdNext = true;
	a.send({ type: "prompt", text: "Hold the fixture turn", requestId: "busy-check" });
	await wait(() => release && a.state.isStreaming, "running fixture");
	assert.equal((await request(a, "builtin-list")).canReload, false);
	release(); release = undefined;
	await wait(() => !a.state.isStreaming, "settled fixture");
	const old = a.state.conversationId; a.send({ type: "new_chat", fresh: true });
	await wait(() => a.state.conversationId !== old && !a.state.tree?.verifying, "new chat");
	assert.equal(item(await request(a, "builtin-list"), "pi-harness-okf").status, "disabled");
	assert.equal(item(await toggle(a, "pi-harness-okf", true), "pi-harness-okf").status, "pending");
	await reload(a);
	assert.equal(JSON.parse(readFileSync(join(data, "document-extensions.json"), "utf8")).okfEnabled, true);
	const c = await connect("builtin-c"); assert.equal(item(await request(c, "builtin-list"), "pi-harness-okf").status, "loaded");
	const saved = readFileSync(join(data, "document-extensions.json"), "utf8");
	writeFileSync(join(data, "document-extensions.json"), "broken-json");
	const broken = await request(a, "builtin-list"); assert.equal(broken.items.length, 5); assert.equal(item(broken, "pi-harness-okf").status, "error"); assert.equal(item(broken, "codemode").status, "loaded");
	writeFileSync(join(data, "document-extensions.json"), saved);
	console.log("PASS built-in inventory, removed conversion, version conflicts, cross-client settings, disabled calls, new chat/reload and real WebSocket OKF workflow");

	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core"), { CHROME_PATH } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
		await context.addInitScript(() => { if (!localStorage.getItem("pi-harness:lang")) localStorage.setItem("pi-harness:lang", "zh"); });
		const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15000);
		await page.goto(`http://127.0.0.1:${port}`);
		async function openSettings(en = false) {
			try { await page.getByRole("button", { name: en ? "Settings" : "设置", exact: true }).first().click(); }
			catch (error) { throw Error(`${error.message}\nPage errors: ${JSON.stringify(errors)}\nPage: ${(await page.locator("body").innerText()).slice(0, 3000)}`); }
			await page.getByText(en ? "All settings" : "所有设置", { exact: true }).click();
			await page.getByRole("button", { name: "Extensions", exact: true }).click();
			await page.locator('[data-builtin-id="pi-harness-okf"]').waitFor();
		}
		await openSettings();
		const panel = page.locator(".builtin-extensions"), okf = panel.locator('[data-builtin-id="pi-harness-okf"]');
		assert.equal(await panel.locator(".builtin-row").count(), 5);
		await page.getByRole("tab", { name: "已安装 · 0", exact: true }).waitFor();
		await okf.getByRole("switch").click(); await wait(() => JSON.parse(readFileSync(join(data, "document-extensions.json"), "utf8")).okfEnabled === false, "browser toggle off");
		await okf.getByRole("switch").click(); await wait(() => JSON.parse(readFileSync(join(data, "document-extensions.json"), "utf8")).okfEnabled === true, "browser toggle on");
		await okf.locator("summary").click(); await okf.getByRole("button", { name: "复制命令", exact: true }).first().click();
		assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "/okf ingest ./raw");
		assert.equal(await panel.locator('[data-builtin-id="pi-harness-pdf-markdown"]').count(), 0);
		await panel.locator('[data-builtin-id="codemode"]').getByRole("button", { name: "查看设置", exact: true }).click();
		await page.locator(".native-mcp-panel").waitFor();
		await page.getByRole("button", { name: "Extensions", exact: true }).click();
		await page.route("**/api/extensions", async route => {
			if (route.request().postDataJSON()?.action === "list") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Package fixture unavailable" }) });
			await route.continue();
		});
		await page.reload(); await openSettings(); assert.equal(await panel.locator(".builtin-row").count(), 5);
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
		console.log("PASS built-in browser: five entries, toggles, copy, settings links, package failure isolation, Chinese/English and narrow layout");
	}
} finally {
	release?.();
	await browser?.close(); for (const client of clients) client.ws.terminate();
	if (child?.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; }
	model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); rmSync(root, { recursive: true, force: true });
}
