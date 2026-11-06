import { expect, test, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodemodeHistory, codemodeHistoryContent } from "../../server/codemode-history.js";
import { serializeMessage } from "../../server/serialize.js";
import { currentCodemodeGroups } from "../../web/src/codemode-records.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { TOOL_TEXT_CONTINUE_PROMPT } from "../../server/tool-text.js";
const assistant = (id: string, text?: string): AssistantMessage => ({ role: "assistant", content: text ? [{ type: "text", text }] : [{ type: "toolCall", id, name: "codemode", arguments: { code: 'text("hello")' } }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: text ? "stop" : "toolUse", timestamp: 2 });
const serialize = (message: Parameters<typeof serializeMessage>[0], entryId: string) => {
	const value = serializeMessage(message, 0);
	return value ? { ...value, id: entryId, entryId } : null;
};
function fixture() {
	const manager = SessionManager.inMemory("/tmp/codemode-history-unit");
	const user = manager.appendMessage({ role: "user", content: "Inspect project", timestamp: 1 });
	const call = manager.appendMessage(assistant("cm"));
	const result = manager.appendMessage({ role: "toolResult", toolCallId: "cm", toolName: "codemode", isError: false, content: [{ type: "text", text: "private output body" }], details: { calls: [{ id: "cm/read", name: "read", args: "{}", status: "ok" }] }, timestamp: 3 });
	return { manager, user, call, result };
}
test("split-turn compaction, full compaction and reload preserve the request without a plan", () => {
	const { manager, call, result } = fixture();
	const projection = new CodemodeHistory();
	const before = projection.snapshot(manager, serialize);
	manager.appendCompaction("Summary", call, 10000);
	const context = manager.buildSessionProjection().messages.map((message, index) => serializeMessage(message, index)!).filter(Boolean);
	expect(context.some(message => message.role === "user")).toBe(false);
	const after = projection.snapshot(manager, serialize);
	expect(currentCodemodeGroups(context, null, false, { codemode: after })[0]).toMatchObject({ id: "cm", status: "completed", entryId: result });
	expect(after.history).toEqual(before.history);
	expect(JSON.stringify(after)).not.toContain("private output body");
	expect(after.history.flatMap(message => message.content).filter(block => block.type === "toolCall").every(block => "argumentsText" in block && block.argumentsText === "")).toBe(true);
	manager.appendCompaction("All summarized", null, 10000);
	expect(new CodemodeHistory().snapshot(manager, serialize).history).toEqual(before.history);
});
test("new request and branch selection invalidate cached request scope", () => {
	const { manager, user, result } = fixture();
	const projection = new CodemodeHistory();
	const before = projection.snapshot(manager, serialize);
	expect(projection.snapshot(manager, serialize).history).toBe(before.history);
	manager.appendMessage({ role: "user", content: "Next task", timestamp: 4 });
	expect(currentCodemodeGroups([], null, false, { codemode: projection.snapshot(manager, serialize) })).toEqual([]);
	manager.branch(result);
	expect(projection.snapshot(manager, serialize).history).toEqual(before.history);
	manager.branch(user);
	expect(currentCodemodeGroups([], null, false, { codemode: projection.snapshot(manager, serialize) })).toEqual([]);
});
test("native live details survive snapshots but completed results and a different session clear them", () => {
	const manager = SessionManager.inMemory("/tmp/codemode-history-unit");
	manager.appendMessage({ role: "user", content: "Work", timestamp: 1 }); manager.appendMessage(assistant("live"));
	const projection = new CodemodeHistory();
	projection.live.set("live", { calls: [{ id: "live/?", name: "read", args: "{}", status: "running" }], totalCalls: 1 });
	const snapshot = projection.snapshot(manager, serialize);
	expect(currentCodemodeGroups([], null, true, { codemode: snapshot })[0].calls[0].status).toBe("running");
	manager.appendMessage({ role: "toolResult", toolCallId: "live", toolName: "codemode", content: [], isError: false, timestamp: 3 });
	expect(projection.snapshot(manager, serialize).live).toEqual([]);
	projection.live.set("old", { calls: [], totalCalls: 0 });
	expect(projection.snapshot(SessionManager.inMemory(), serialize)).toEqual({ history: [], live: [] });
});
test("history detail reads validate branch and matching call without navigating", () => {
	const { manager, user, call, result } = fixture();
	manager.appendCompaction("Summary", null, 10000);
	const leaf = manager.getLeafId();
	const content = codemodeHistoryContent(manager, result, "cm");
	expect(content.block.id).toBe("cm");
	expect(content.result?.content[0]).toMatchObject({ text: "private output body" });
	expect(codemodeHistoryContent(manager, call, "cm").result).toEqual(content.result);
	expect(manager.getLeafId()).toBe(leaf);
	expect(() => codemodeHistoryContent(manager, user, "cm")).toThrow();
	manager.branch(user);
	expect(() => codemodeHistoryContent(manager, result, "cm")).toThrow();
});


test("automatic tool-text recovery keeps the request; old output is not serialized again", () => {
	const { manager } = fixture();
	manager.appendMessage(assistant("leak", '<invoke name="read"><parameter name="path">a</parameter></invoke>'));
	manager.appendMessage({ role: "user", content: [{ type: "text", text: TOOL_TEXT_CONTINUE_PROMPT }], timestamp: 5 });
	const projection = new CodemodeHistory();
	expect(currentCodemodeGroups([], null, true, { codemode: projection.snapshot(manager, serialize) })).toHaveLength(1);
	manager.appendMessage({ role: "user", content: "New request", timestamp: 6 });
	const spy = vi.fn(serialize);
	expect(currentCodemodeGroups([], null, true, { codemode: projection.snapshot(manager, spy) })).toEqual([]);
	expect(spy.mock.calls.some(([message]) => message.role === "toolResult")).toBe(false);
});
