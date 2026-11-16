/** Native extension admission is not completion; explicit attachments reach native handlers. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { mergeSnapshot } from "./lib/snapshots.mjs";
import { testEnv } from "./lib/test-env.mjs";
import { PromptReceipts } from "../dist/server/prompt-receipts.js";
const root = mkdtempSync(join(tmpdir(), "omp-command-receipts-")), data = join(root, "data"), cwd = join(root, "work"), agent = join(data, "omp/agent"), log = join(root, "calls.jsonl"), gate = join(root, "release");
mkdirSync(cwd); mkdirSync(join(agent, "extensions"), { recursive: true });
writeFileSync(log, "");
writeFileSync(join(agent, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
writeFileSync(join(agent, "extensions", "receipt.js"), `import { appendFileSync, existsSync } from 'node:fs';
export default api => api.registerCommand('fixture-receipt', {handler: async (args, ctx) => {
 appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
 const action = args.split('\\n', 1)[0].trim();
 if (action === 'hold') while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 20));
 else await new Promise(resolve => setTimeout(resolve, 400));
 if (action === 'fail') throw Error('FIXTURE_PRIVATE_ERROR');
 ctx.ui.notify('completed:' + action);
}});`);
let harness, ws, browser, state, wire = [], modelCalls = 0;
const provider = createServer((req, res) => { modelCalls++; req.resume(); res.writeHead(500); res.end(); });
const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const send = message => ws.send(JSON.stringify(message));
async function wait(predicate, label = "event") { const end = Date.now() + 30000; while (Date.now() < end) { const found = predicate(); if (found) return found; await sleep(20); } throw Error(`Timed out: ${label}`); }
const receipt = id => wait(() => wire.find(event => event.type === "prompt_result" && event.requestId === id), id);
const invalidAttachments = [{ path: "missing", editorSnapshot: { cwd: "/wrong", text: "must not validate", dirty: true } }, { path: "", name: "not-uploaded.txt", fileData: "aGVsbG8=" }];
const body = 'const literal = "two  spaces";\n\tkeep quotes and whitespace\n';
const file = join(cwd, "explicit.txt"); writeFileSync(file, body);
const attachments = [{ path: file, mode: "inline" }];
try {
	const port = await listenIsolated(provider);
	writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { fixture: { api: "anthropic-messages", baseUrl: `http://127.0.0.1:${port}`, apiKey: "fixture", models: [{ id: "fixture" }] } } }));
	const env = testEnv({ PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data });
	for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
	harness = await startIsolatedHarness({ env });
	ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`); ws.on("message", raw => { const message = JSON.parse(String(raw)); wire.push(message); state = mergeSnapshot(state, message); });
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); }); send({ type: "hello", clientId: "command-receipts" }); await wait(() => wire.some(event => event.type === "ready"));
	send({ type: "prompt", text: "/fixture-receipt", requestId: "bare", attachments });
	assert.equal((await receipt("bare")).receipt, "accepted");
	await wait(() => calls().length || modelCalls, "bare command dispatch");
	assert.equal(modelCalls, 0, "bare extension command with attachments must not become a model prompt");
	assert(calls()[0].includes(body), "bare extension receives explicit attachment");
	await wait(() => !state.isStreaming); writeFileSync(log, "");
	const held = { type: "prompt", text: "/fixture-receipt hold", requestId: "hold", attachments };
	send(held); const admitted = await receipt("hold"); assert.equal(admitted.receipt, "accepted"); assert.notEqual(admitted.attachmentsConsumed, false);
	assert.equal(admitted.commandExecuted, undefined, "admission cannot invent a local completion");
	assert.equal(calls().length, 1); assert(calls()[0].startsWith("hold\n"));
	assert(calls()[0].includes(body), "native extension receives explicit attachment verbatim");
	assert(!existsSync(join(data, "uploads", "command-receipts")));
	send(held); await sleep(100); assert.equal(calls().length, 1, "duplicate admission cannot rerun the command");
	wire = [];
	writeFileSync(gate, "release");
	await wait(() => wire.some(event => event.type === "notice" && event.text === "completed:hold"));
	await sleep(100); assert(!wire.some(event => event.type === "prompt_result"), "completion must not push a second admission receipt");
	let settledReceipt;
	for (let attempt = 0; attempt < 100; attempt++) {
		wire = []; send({ type: "query_prompt_receipt", requestId: "hold" }); settledReceipt = await receipt("hold");
		if (settledReceipt.commandExecuted) break;
		await sleep(20);
	}
	assert.equal(settledReceipt.commandExecuted, true, "same-ID native local result persisted for query");
	assert.deepEqual(new PromptReceipts(data).query("command-receipts", "hold"), settledReceipt, "local handling annotation survives ledger reload");
	await wait(() => !state.isStreaming);
	send({ type: "prompt", text: "/fixture-receipt fail", requestId: "fail", attachments }); assert.equal((await receipt("fail")).receipt, "accepted");
	await wait(() => wire.some(event => event.type === "notice" && event.level === "error" && event.conversationId === state.conversationId), "native extension error visible");
	await wait(() => state.errorMessage && !state.isStreaming, "failure state remains visible");
	assert(!JSON.stringify(wire).includes("FIXTURE_PRIVATE_ERROR"), "raw extension error is not returned");
	assert.equal(calls().length, 2); assert(calls()[1].startsWith("fail\n")); assert(calls()[1].includes(body));
	for (const [requestId, text] of [["invalid", "ordinary prompt"], ["invalid-command", "/fixture-receipt invalid"]]) {
		wire = []; send({ type: "prompt", text, requestId, attachments: invalidAttachments });
		assert.equal((await receipt(requestId)).receipt, "rejected", "ordinary and extension attachments must pass validation");
	}
	assert.equal(calls().length, 2, "invalid attachments cannot execute an extension handler");
	if (process.argv.includes("--browser")) {
		const { chromium } = await import("playwright-core"), { CHROME_PATH } = await import("./lib/chrome.mjs");
		browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
		const page = await browser.newPage(); page.setDefaultTimeout(30000);
		await page.addInitScript(() => sessionStorage.setItem("pi-web-client-id", "command-receipts"));
		const errors = [], frames = []; page.on("pageerror", error => errors.push(error.message));
		page.on("websocket", socket => socket.on("framereceived", ({payload}) => frames.push(JSON.parse(String(payload)))));
		await page.goto(`http://127.0.0.1:${harness.port}`); await page.locator(".conn-dot.ok").first().waitFor({state:"attached"});
		const composer = page.locator(".inputbox textarea").first(), upload = page.locator('.inputbox input[type="file"]');
		await upload.setInputFiles({name:"explicit-upload.txt",mimeType:"text/plain",buffer:Buffer.from("frozen upload")});
		await composer.fill("/fixture-receipt browser"); await page.locator(".composer-action.send").click();
		await page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value === "");
		assert.equal(await page.locator(".attach-chip.file").count(), 0);
		assert.equal(await page.locator(".pending-echo").count(), 0);
		await wait(() => frames.some(event => event.type === "notice" && event.text === "completed:browser"));
		assert(calls().some(args => args.startsWith("browser\n") && args.includes("frozen upload")), "uploaded content reaches native handler");
		await upload.setInputFiles({name:"failure.txt",mimeType:"text/plain",buffer:Buffer.from("failure attachment")});
		frames.length = 0; await composer.fill("/fixture-receipt fail"); await page.locator(".composer-action.send").click();
		await wait(() => frames.some(event => event.type === "notice" && event.level === "error"));
		assert(frames.some(event => event.type === "prompt_result" && event.receipt === "accepted"), "handler failure does not retroactively reject native admission");
		assert.equal(await page.locator(".attach-chip.file").count(), 0);
		await wait(() => !state.isStreaming);
		await composer.fill("/fixture-receipt newer-draft"); await page.locator(".composer-action.send").click(); await composer.fill("keep my newer draft");
		await upload.setInputFiles({name:"new.txt",mimeType:"text/plain",buffer:Buffer.from("new upload")});
		await wait(() => frames.some(event => event.type === "notice" && event.text === "completed:newer-draft"));
		assert.equal(await composer.inputValue(), "keep my newer draft"); assert.equal(await page.locator(".attach-chip.file").count(), 1);
		assert(calls().some(args => args.startsWith("fail\n") && args.includes("failure attachment")));
		assert.deepEqual(errors, []);
		console.log("PASS browser command admission: native attachment consumption on success/late failure, no phantom model echo, newer draft and uploads untouched");
	}
	assert.equal(modelCalls, 0);
	console.log("PASS native command receipts: immediate admission, native attachment delivery, same-ID local result, durable query, no duplicate execution and visible late failure");
} finally { await browser?.close(); ws?.terminate(); await harness?.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true }); }
