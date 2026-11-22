import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { insertComposerText } from "../../web/src/composer-text.js";
import { designFirstResources } from "../../server/design-first-resources.js";

const command = "/skill:design-first";
test.each(["\t", "\n", "\r\n", "\u00a0"])("preparing a command preserves %j and remains idempotent", whitespace => {
	const draft = `${command}${whitespace}原始内容\n`;
	const prepared = insertComposerText(draft, command, "command");
	expect(prepared).toBe(`${command} ${whitespace}原始内容\n`);
	expect(insertComposerText(prepared, command, "command")).toBe(prepared);
});

test("full command names, plain drafts and append retain their distinct behavior", () => {
	expect(insertComposerText(command, command, "command")).toBe(command);
	expect(insertComposerText(`${command} existing`, command, "command")).toBe(`${command} existing`);
	expect(insertComposerText(`${command}-extra text`, command, "command")).toBe(`${command} ${command}-extra text`);
	expect(insertComposerText("keep draft", command, "command")).toBe(`${command} keep draft`);
	expect(insertComposerText("keep\t\r\ndraft", "result", "append")).toBe("keep\t\r\ndraft\n\nresult");
});

test("prepared whitespace commands actually expand through the native SDK skill path", async () => {
	const root = await mkdtemp(join(tmpdir(), "composer-skill-"));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:8999", apiKey: "fixture", models: [{ id: "test", input: ["text"], contextWindow: 32000, maxTokens: 4096 }] } } }));
		const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), modelsStorePath: join(root, "store.json"), allowModelNetwork: false, refreshOnCreate: false });
		const settings = SettingsManager.inMemory({ defaultTools: [], compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, ...designFirstResources("normal", root, resolve(".")) });
		await loader.reload();
		({ session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("fixture", "test")!, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) }));
		const prompts: string[] = [];
		session.agent.streamFunction = (_model, context) => {
			expect(_model.id).toBe("test");
			prompts.push(JSON.stringify(context.messages.filter(m => m.role === "user").at(-1)));
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: { role: "assistant", api: "openai-completions", provider: "fixture", model: "test", timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "Fixture only" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
			return stream;
		};
		for (const whitespace of ["\t", "\n", "\r\n"]) await session.prompt(insertComposerText(`${command}${whitespace}原始内容`, command, "command"));
		expect(prompts).toHaveLength(3);
		for (const prompt of prompts) {
			expect(prompt).toContain("## Start or resume");
			expect(prompt).toContain("原始内容");
		}
		await session.prompt('/skill:bug-fix "保留 $1 字面量的错误"');
		await session.prompt('/skill:feat "新增名称筛选"');
		expect(prompts).toHaveLength(5);
		expect(prompts[3]).toContain("Bug fix route");
		expect(prompts[3]).toContain("保留 $1 字面量的错误");
		expect(prompts[4]).toContain("Small feature route");
		expect(prompts[4]).toContain("新增名称筛选");
	} finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
});
