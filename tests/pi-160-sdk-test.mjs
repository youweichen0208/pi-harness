/** Pi 1.6.0 native export, model, diagnostics and find contracts. No model or network calls. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
	createFindTool, SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const root = mkdtempSync(join(tmpdir(), "pi-160-native-"));
const runtimes = [];
const sessions = [];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const oscLink = "\x1b]8;;https://example.com\x07Example link\x1b]8;;\x07";
const customTool = {
	name: "link_fixture", label: "Link fixture", description: "Fixture", parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	renderCall: () => ({ render: () => [oscLink] }),
	renderResult: () => ({ render: () => [oscLink] }),
};
async function services(cwd) {
	return createAgentSessionServices({ cwd, agentDir: join(root, "agent"), settingsManager: undefined });
}
try {
	const manager = SessionManager.create(root);
	const baseServices = await services(root);
	const created = await createAgentSessionFromServices({ services: baseServices, sessionManager: manager, customTools: [customTool] });
	sessions.push(created.session);
	const main = manager.appendMessage({ role: "user", content: "main branch", timestamp: 1 });
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "custom-call", name: "link_fixture", arguments: {} }], api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason: "toolUse", timestamp: 2 });
	manager.appendMessage({ role: "toolResult", toolCallId: "custom-call", toolName: "link_fixture", isError: false, content: [{ type: "text", text: "linked output" }], timestamp: 3 });
	manager.branch(main);
	manager.appendMessage({ role: "user", content: "current branch only", timestamp: 4 });

	const htmlPath = join(root, "full-tree.html");
	await created.session.exportToHtml(htmlPath);
	const html = readFileSync(htmlPath, "utf8");
	const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	assert(encoded, "native HTML embeds session data");
	const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	const serializedEntries = JSON.stringify(data.entries);
	assert(serializedEntries.includes("main branch") && serializedEntries.includes("current branch only"), "HTML contains the entire tree, not only the current branch");
	assert.equal(typeof data.systemPrompt, "string"); assert(Array.isArray(data.tools));
	assert(data.renderedTools["custom-call"].callHtml.includes('<a href="https://example.com"'));
	assert(!JSON.stringify(data.renderedTools).includes("\\u001b]8"), "custom tool HTML contains no raw OSC 8 escapes");
	console.log("PASS native HTML full-tree export and clickable OSC 8 custom-tool links");

	const jsonlPath = join(root, "current-branch.jsonl");
	created.session.exportToJsonl(jsonlPath);
	const jsonl = readFileSync(jsonlPath, "utf8");
	assert(jsonl.includes("current branch only") && jsonl.includes("main branch"));
	assert(!jsonl.includes("custom-call"), "JSONL contains only the current branch");
	const importRoot = join(root, "import"); mkdirSync(importRoot);
	const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager }) => {
		const nextServices = await services(cwd);
		const next = await createAgentSessionFromServices({ services: nextServices, sessionManager });
		return { ...next, services: nextServices, diagnostics: nextServices.diagnostics };
	}, { cwd: importRoot, agentDir: join(root, "agent"), sessionManager: SessionManager.create(importRoot) });
	runtimes.push(runtime);
	const imported = await runtime.importFromJsonl(jsonlPath);
	assert.equal(imported.cancelled, false);
	assert(runtime.session.messages.some(message => message.role === "user" && message.content === "current branch only"));
	assert(!JSON.stringify(runtime.session.messages).includes("custom-call"));
	console.log("PASS native current-branch JSONL export and runtime import");

	runtime._diagnostics = [{ type: "warning", message: "report once" }];
	assert.equal(runtime.takeUnreportedDiagnostics().length, 1);
	assert.equal(runtime.takeUnreportedDiagnostics().length, 0);
	runtime._diagnostics = [{ type: "warning", message: "report once" }, { type: "error", message: "new problem" }];
	assert.deepEqual(runtime.takeUnreportedDiagnostics().map(item => item.message), ["new problem"]);
	console.log("PASS runtime diagnostics are consumed once with type/message deduplication");

	const memoryServices = await services(root);
	const memory = await createAgentSessionFromServices({ services: memoryServices, sessionManager: SessionManager.inMemory(root) });
	sessions.push(memory.session);
	await assert.rejects(memory.session.exportToHtml(join(root, "memory.html")), /in-memory/);
	console.log("PASS in-memory HTML export fails explicitly");

	for (const provider of ["openai", "azure", "openai-codex"]) {
		const model = baseServices.modelRuntime.getModel(provider, "gpt-6.2-sol");
		assert(model, `${provider} GPT-6.2 Sol is in the native catalog`);
		assert(!getSupportedThinkingLevels(model).includes("off"), `${provider} GPT-6.2 Sol cannot disable reasoning`);
	}
	console.log("PASS GPT-6.2 native catalog and thinking-level availability");

	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "pkg", "src"), { recursive: true });
	mkdirSync(join(root, "src", "nested"), { recursive: true });
	for (const path of ["src/a.ts", "src/nested/b.ts", "pkg/src/c.ts"]) writeFileSync(join(root, path), "export {}\n");
	const find = createFindTool(root);
	const findText = async pattern => (await find.execute(`find-${pattern}`, { pattern })).content.map(part => part.text ?? "").join("\n");
	const direct = await findText("src/*.ts");
	assert(direct.includes("src/a.ts") && !direct.includes("pkg/src/c.ts") && !direct.includes("src/nested/b.ts"));
	const anyDepth = await findText("**/src/*.ts");
	assert(anyDepth.includes("src/a.ts") && anyDepth.includes("pkg/src/c.ts") && !anyDepth.includes("src/nested/b.ts"));
	assert.equal(await findText("./src/*.ts"), direct);
	console.log("PASS native find glob paths are relative to the search directory, including ./ and **");
} finally {
	for (const session of sessions.splice(0)) session.dispose();
	for (const runtime of runtimes.splice(0)) await runtime.dispose().catch(() => {});
	rmSync(root, { recursive: true, force: true });
}
