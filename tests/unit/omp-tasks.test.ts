import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { OmpTasks, taskMessagePage } from "../../server/omp/tasks.js";

const parent: UiMessage[] = [{ id: "parent", role: "assistant", content: [{ type: "toolCall", id: "spawn", name: "task" }] }];
const lifecycle = (id: string, status: string, parentToolCallId = "spawn") => ({ type: "subagent_lifecycle", payload: { id, status, parentToolCallId, agent: "task", sessionFile: "/secret/session.jsonl", headers: { Authorization: "secret" } } });

describe("OMP task ownership", () => {
	it("keeps terminal state across stale progress and isolates generations and branches", () => {
		const tasks = new OmpTasks(); tasks.observe(lifecycle("child", "started"), "g1");
		const id = tasks.visible(parent)[0].id;
		expect(tasks.resolve(id, "g1", parent).nativeId).toBe("child");
		expect(() => tasks.resolve(id, "g2", parent)).toThrow();
		expect(tasks.visible([])).toEqual([]);
		tasks.observe(lifecycle("child", "completed"), "g1");
		tasks.observe({ type: "subagent_progress", payload: { parentToolCallId: "spawn", progress: { id: "child", status: "running", tokens: 23 } } }, "g1");
		expect(tasks.visible(parent)[0]).toMatchObject({ status: "completed", canStop: false, tokens: 23 });
		tasks.observe({ type: "subagent_progress", payload: { parentToolCallId: "spawn", progress: { id: "child", status: "failed", tokens: 1 } } }, "g1");
		expect(tasks.visible(parent)[0]).toMatchObject({ status: "completed", tokens: 23 });
		expect(JSON.stringify(tasks.visible(parent))).not.toMatch(/secret|sessionFile|headers/);
	});
	it("allows nested tasks only through tool calls actually observed in an owned child", () => {
		const tasks = new OmpTasks(); tasks.observe(lifecycle("child", "started"), "g1");
		tasks.observe(lifecycle("nested", "started", "nested-spawn"), "g1");
		expect(tasks.visible(parent)).toHaveLength(1);
		tasks.observe({ type: "subagent_event", payload: { id: "child", event: { type: "tool_execution_start", toolCallId: "nested-spawn" } } }, "g1");
		expect(tasks.visible(parent)).toHaveLength(2);
		const nestedId = tasks.visible(parent).find(task => task.parentToolCallId === "nested-spawn")!.id;
		expect(tasks.outputPath(nestedId, parent)).toEqual([{ nativeId: "child", parentToolCallId: "spawn" }, { nativeId: "nested", parentToolCallId: "nested-spawn" }]);
		tasks.interrupt(); expect(tasks.visible(parent).every(task => task.status === "interrupted" && !task.canStop)).toBe(true);
		expect(tasks.outputPath(nestedId, parent)).toHaveLength(2);
		expect(() => tasks.outputPath(nestedId, [])).toThrow();
		expect(tasks.visible([])).toEqual([]);
	});
	it("refuses an old task handle when a native id is rebound to another call", () => {
		const tasks = new OmpTasks(); tasks.observe(lifecycle("child", "started"), "g1");
		const id = tasks.visible(parent)[0].id;
		tasks.observe(lifecycle("child", "completed"), "g1");
		tasks.observe(lifecycle("child", "started", "other-spawn"), "g1");
		expect(() => tasks.resolve(id, "g1", parent)).toThrow();
		expect(() => tasks.outputPath(id, parent)).toThrow();
	});
	it("restores read-only records, preserves live authority and expires old generations", () => {
		const tasks = new OmpTasks(); tasks.observe(lifecycle("child", "started"), "g1");
		const old = tasks.visible(parent)[0].id;
		const rows = [{ nativeId: "child", parentToolCallId: "spawn", historyHandle: "private-handle", status: "completed", children: ["nested-spawn"] }, { nativeId: "nested", parentToolCallId: "nested-spawn", historyHandle: "nested-handle", status: "running", children: [] }];
		tasks.restore(rows, "g1");
		expect(tasks.visible(parent)[0]).toMatchObject({ id: old, status: "running", canStop: true });
		tasks.restore(rows, "g2");
		expect(() => tasks.resolve(old, "g2", parent)).toThrow();
		expect(tasks.visible(parent).map(task => [task.status, task.canStop])).toEqual([["completed", false], ["interrupted", false]]);
		const id = tasks.visible(parent)[0].id;
		expect(tasks.resolve(id, "g2", parent).historyHandle).toBe("private-handle");
		expect(JSON.stringify(tasks.visible(parent))).not.toContain("private-handle");
		tasks.restore([], "g2"); expect(tasks.visible(parent)).toEqual([]);
	});
});

it("keeps child tool/result identity alongside a bounded preview without exposing native details", () => {
	const page = taskMessagePage([{ role: "toolResult", toolCallId: "child-call", toolName: "bash", isError: false,
		content: [{ type: "text", text: "x".repeat(20000) }], details: { privatePath: "/private/artifact.log" } }], 0);
	expect(page.messages[0]).toMatchObject({ toolCallId: "child-call", toolName: "bash", isError: false });
	expect(page.truncated).toBe(true);
	expect(JSON.stringify(page)).not.toContain("privatePath");
	const oversized = taskMessagePage([{ role: "toolResult", toolCallId: "a".repeat(2001), content: [] }], 0);
	expect(oversized.messages[0].toolCallId).toBeUndefined();
});

it("bounds transcript pages containing many empty tool calls", () => {
	const page = taskMessagePage([{ role: "assistant", content: Array.from({ length: 50000 }, () => ({ type: "toolCall", id: "call", name: "read", arguments: {} })) }], 0);
	expect(page.truncated).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024 * 1024);
});

it("paginates native task messages and explicitly marks display truncation without SDK metadata", () => {
	const messages = Array.from({ length: 65 }, (_, timestamp) => ({ role: "assistant", timestamp, content: [{ type: "text", text: "x".repeat(20000) }], headers: { secret: "hidden" }, thinkingSignature: "hidden" }));
	const first = taskMessagePage(messages, 0), second = taskMessagePage(messages, first.nextCursor);
	expect(first.messages).toHaveLength(30); expect(first.nextCursor).toBe(30); expect(first.hasMore).toBe(true); expect(first.truncated).toBe(true);
	expect(second.messages[0].id).not.toBe(first.messages[0].id);
	expect(JSON.stringify(first)).not.toContain("hidden");
	expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024 * 1024);
});
