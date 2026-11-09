import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { runSubagent } from "../../server/subagents/runner.js";

const fixture = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async original => {
	const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...sdk, createAgentSession: async (...args: Parameters<typeof sdk.createAgentSession>) => {
		const created = await sdk.createAgentSession(...args);
		created.session.agent.streamFunction = fixture.stream;
		return created;
	} };
});
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function run(errors: string[], controller = new AbortController(), onRequest?: (count: number) => void, mode: "error" | "aborted" | "throw" = "error") {
	root = await mkdtemp(join(tmpdir(), "subagent-retry-"));
	await writeFile(join(root, "evidence.txt"), "Completed research survives a network interruption.\n");
	await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:8999", apiKey: "fixture", models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), modelsStorePath: join(root, "store.json"), allowModelNetwork: false, refreshOnCreate: false });
	const contexts: unknown[] = [];
	fixture.stream.mockReset().mockImplementation((_model, context) => {
		contexts.push(structuredClone(context)); onRequest?.(contexts.length);
		const error = contexts.length > 1 ? errors[contexts.length - 2] : undefined;
		if (error && mode === "throw") throw new DOMException(error, "AbortError");
		const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "fixture", model: "test", timestamp: Date.now(), usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: contexts.length === 1 ? [{ type: "toolCall", id: "read-once", name: "source_read", arguments: { path: "evidence.txt" } }] : [{ type: "text", text: error ? "Partial investigation" : "Recovered answer" }], stopReason: contexts.length === 1 ? "toolUse" : error ? mode === "aborted" ? "aborted" : "error" : "stop", ...(error ? { errorMessage: error } : {}) };
		const stream = new AssistantMessageEventStream();
		if (error) stream.push({ type: "error", reason: mode === "aborted" ? "aborted" : "error", error: message });
		else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
		return stream;
	});
	const result = await runSubagent({ source: { id: "repo", name: "Repo", root, kind: "repository" }, task: "Read evidence.txt" }, { agentDir: root, modelRuntime: runtime, model: runtime.getModel("fixture", "test")!, thinkingLevel: "off" }, controller.signal, () => {});
	return { result, contexts };
}
test("retries a request AbortError in the same native session after a successful read", async () => {
	const { result, contexts } = await run(["This operation was aborted"]);
	expect(result.status).toBe("completed"); expect(result.text).toBe("Recovered answer");
	expect(contexts).toHaveLength(3); expect(result.usage?.input).toBe(30);
	expect(result.steps).toHaveLength(1); expect(result.steps?.[0].status).toBe("completed");
	expect(JSON.stringify(contexts[2])).toContain("Completed research survives");
});
test("exhaustion retains partial output, completed work and cause", async () => {
	const { result, contexts } = await run(Array(3).fill("fetch failed"));
	expect(result.status).toBe("failed"); expect(contexts).toHaveLength(4);
	expect(result.text).toContain("fetch failed"); expect(result.text).toContain("evidence.txt");
	expect(result.text).toContain("Partial investigation"); expect(result.text).toContain("elapsed");
});
test("explicit cancellation never retries", async () => {
	const controller = new AbortController();
	const { result, contexts } = await run(["This operation was aborted"], controller, count => { if (count === 2) controller.abort(new Error("Parent cancelled")); });
	expect(result.status).toBe("cancelled"); expect(contexts).toHaveLength(2);
});
test.each(["aborted", "throw"] as const)("recovers %s without a host cancellation", async mode => {
	const { result, contexts } = await run(["This operation was aborted"], new AbortController(), undefined, mode);
	expect(result.status).toBe("completed"); expect(contexts).toHaveLength(3);
	expect(result.steps).toHaveLength(1);
});
test("does not retry permanent authentication failures", async () => {
	const { result, contexts } = await run(["401 Invalid API key"]);
	expect(result.status).toBe("failed"); expect(contexts).toHaveLength(2);
});
test("cancellation interrupts native retry backoff", async () => {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const { result, contexts } = await run(["fetch failed"], controller, count => {
			if (count === 2) timer = setTimeout(() => controller.abort(new Error("Stopped during backoff")), 50);
		});
		expect(result.status).toBe("cancelled"); expect(contexts).toHaveLength(2);
		expect(result.text).toContain("retry backoff");
	} finally { clearTimeout(timer); }
});
