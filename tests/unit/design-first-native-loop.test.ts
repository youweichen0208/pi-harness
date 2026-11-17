import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { designFirstResources } from "../../server/design-first-resources.js";

// A scripted model verifies SDK/tool wiring, not whether a real model obeys the skill.
test("default skill uses the selected model and native tools for design, implementation, testing and fresh-session recovery", async () => {
	const root = await mkdtemp(join(tmpdir(), "design-first-native-loop-"));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:8999", apiKey: "fixture", models: [{ id: "selected", input: ["text"], contextWindow: 32000, maxTokens: 4096 }] } } }));
		await writeFile(join(root, "sum.cjs"), "exports.sum = (a, b) => a - b;\n");
		await writeFile(join(root, "sum.test.cjs"), "const {test} = require('node:test'); const assert = require('node:assert/strict'); const {sum} = require('./sum.cjs'); test('adds', () => assert.equal(sum(2, 3), 5));\n");
		const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), modelsStorePath: join(root, "store.json"), allowModelNetwork: false, refreshOnCreate: false });
		const model = runtime.getModel("fixture", "selected")!;
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, ...designFirstResources("normal", root, resolve(".")) });
		await loader.reload();
		const create = async () => (await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model, tools: ["read", "write", "edit", "bash"], settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) })).session;
		session = await create();
		const doc = "docs/changes/addition/";
		let id = 0;
		const call = (name: string, args: Record<string, string>): AssistantMessage["content"] => [{ type: "toolCall", id: `native-${++id}`, name, arguments: args }];
		const say = (text: string): AssistantMessage["content"] => [{ type: "text", text }];
		const results: string[] = [];
		const drive = async (prompt: string, steps: Array<() => AssistantMessage["content"]>) => {
			let cursor = 0;
			session!.agent.streamFunction = (currentModel, context) => {
				expect(currentModel.id).toBe("selected");
				const last = context.messages.at(-1);
				if (last?.role === "toolResult") results.push(JSON.stringify(last));
				if (cursor === 0 && prompt.startsWith("/design")) expect(JSON.stringify(last)).toContain("Design First");
				const content = steps[cursor++]();
				const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "done", reason: stopReason, message: { role: "assistant", api: "openai-completions", provider: "fixture", model: "selected", timestamp: Date.now(), stopReason, content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
				return stream;
			};
			await session!.prompt(prompt);
			expect(cursor).toBe(steps.length);
		};
		await drive("/design 修正加法并运行测试，先给我设计和任务。", [
			() => call("write", { path: doc + "design.md", content: "# Design v1\n| Requirement ID | Requested behavior | Scenario | Public seam / acceptance evidence |\n| R1 | Make sum(2,3) return 5 | Given 2 and 3, when sum is called, then return 5 | exports.sum; node --test --test-reporter=tap sum.test.cjs |\nSpec impact: no canonical spec exists; retain R1 in this design.\n" }),
			() => call("write", { path: doc + "tasks.md", content: "# Tasks\n| Task ID | Requirement ID | Deliverable | Acceptance / verification |\n| T1 | R1 | Fix addition | sum(2,3) returns 5 |\n| T2 | R1 | Run test and record actual result | TAP and exit codes in outcome.md |\n" }),
			() => call("write", { path: doc + "progress.md", content: "change_id: addition\nstage_hint: awaiting_confirmation\nnext_action: Confirm design v1 before editing source\n" }),
			() => say("设计 v1 和任务已保存，等待确认。"),
		]);
		expect(await readFile(join(root, "sum.cjs"), "utf8")).toContain("a - b");
		await drive("确认设计 v1，请实现并运行测试，更新结果。", [
			() => call("bash", { command: "node --test --test-reporter=tap sum.test.cjs" }),
			() => call("edit", { path: "sum.cjs", oldText: "a - b", newText: "a + b" }),
			() => call("bash", { command: "node --test --test-reporter=tap sum.test.cjs" }),
			() => call("read", { path: "sum.cjs" }),
			() => call("read", { path: doc + "design.md" }),
			() => call("write", { path: doc + "outcome.md", content: `# Acceptance coverage\n| Requirement ID | Implementation | Scenario / actual evidence | Status |\n| R1 | sum uses addition | Red then green TAP output below | verified |\n# Review\nCode quality: reviewed the actual a - b to a + b edit and current sum.cjs; no unrelated changes.\nDesign/spec: reread design v1 and matched R1 to the implementation; no canonical spec exists.\n# Actual verification\nCommand: node --test --test-reporter=tap sum.test.cjs\nRecorded: ${new Date().toISOString()}\nEnvironment: ${process.version}, ${process.platform}\n\n${results.filter(result => result.includes('"toolName":"bash"')).join("\n\n")}\n` }),
			() => call("write", { path: doc + "tasks.md", content: "# Tasks\n| Task ID | Requirement ID | Deliverable | Acceptance / verification |\n| T1 | R1 | Fix addition | sum(2,3) returns 5 |\n| T2 | R1 | Run test and record actual result | Red and green evidence saved in outcome.md |\n" }),
			() => call("write", { path: doc + "progress.md", content: "change_id: addition\nstage_hint: completed\nevidence: outcome.md\nnext_action: Recheck current code before reusing historical test results\n" }),
			() => say("源码、测试和结果记录已完成。"),
		]);
		const outcome = await readFile(join(root, doc, "outcome.md"), "utf8");
		expect(outcome).toContain("not ok 1");
		expect(outcome).toContain("# pass 1");
		expect(outcome).toContain("exited with code 1");
		expect(outcome).toContain("| R1 |");
		expect(outcome).toContain("Code quality:");
		expect(outcome).toContain("Design/spec:");
		expect(await readFile(join(root, "sum.cjs"), "utf8")).toContain("a + b");
		session.dispose();
		session = await create();
		expect(session.messages).toHaveLength(0);
		await drive("/design 恢复 addition，仅核实当前进展。", [
			() => call("read", { path: doc + "progress.md" }),
			() => call("read", { path: doc + "outcome.md" }),
			() => call("read", { path: "sum.cjs" }),
			() => say("已从持久文档和当前源码找回完成记录；测试是历史证据。"),
		]);
		expect(results.at(-1)).toContain("a + b");
	} finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
