import { afterEach, expect, test, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { runSubagent, type SubagentParent } from "../../server/subagents/runner.js";
const { create, research } = vi.hoisted(() => ({ create: vi.fn(), research: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ createAgentSession: create, DefaultResourceLoader: class { async reload() {} }, SessionManager: { inMemory() {} }, SettingsManager: { inMemory() {} } }));
vi.mock("../../server/subagents/report.js", () => ({ createSubagentResearchTools: research }));
const source = { id: "repo", name: "Repo", root: "/repo", kind: "repository" as const };
const parent = { agentDir: "/agent" } as SubagentParent;
function setup() {
	vi.useFakeTimers(); vi.setSystemTime(0);
	research.mockResolvedValue({ tools: [], getReport: () => undefined, getReportError: () => undefined });
	const finish: (() => void)[] = [];
	create.mockImplementation(async () => {
		let listener: Parameters<AgentSession["subscribe"]>[0] = () => {};
		let done!: () => void;
		const gate = new Promise<void>(resolve => { done = resolve; });
		finish.push(done);
		return { session: { subscribe(fn: typeof listener) { listener = fn; return () => {}; }, async prompt() { await gate; listener({ type: "agent_settled" } as Parameters<typeof listener>[0]); }, abort: async () => done(), dispose() {}, messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "stop" }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }) } };
	});
	return finish;
}
afterEach(() => vi.useRealTimers());
test("queue time does not consume the independent execution budget or displayed duration", async () => {
	const finish = setup();
	const calls = Array.from({ length: 7 }, () => runSubagent({ source, task: "Read" }, parent, new AbortController().signal, () => {}));
	await vi.advanceTimersByTimeAsync(90000);
	expect(finish).toHaveLength(6);
	finish[0](); await vi.advanceTimersByTimeAsync(0);
	expect(finish).toHaveLength(7);
	let settled = false; void calls[6].then(() => { settled = true; });
	await vi.advanceTimersByTimeAsync(179999);
	expect(settled).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	const results = await Promise.all(calls);
	expect(results[6].text).toContain("180 seconds of execution");
	expect(results[6].durationMs).toBe(180000);
});
test("a full service queue times out without starting investigation", async () => {
	const finish = setup();
	const calls = Array.from({ length: 7 }, () => runSubagent({ source, task: "Read" }, parent, new AbortController().signal, () => {}));
	await vi.advanceTimersByTimeAsync(180000);
	const results = await Promise.all(calls);
	expect(finish).toHaveLength(6);
	expect(results[6]).toMatchObject({ status: "failed", durationMs: 0 });
	expect(results[6].text).toContain("investigation never started");
	// Released slots remain usable by subsequent requests.
	const next = runSubagent({ source, task: "Read" }, parent, new AbortController().signal, () => {});
	await vi.advanceTimersByTimeAsync(0); expect(finish).toHaveLength(7);
	finish[6](); await next;
});
