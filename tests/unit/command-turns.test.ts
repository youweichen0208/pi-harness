import { expect, test } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { commandPhaseLabels, commandTurnSummaries } from "../../web/src/command-turns.js";
const user = (id: string): UiMessage => ({ id, role: "user", content: [{ type: "text", text: id }] });
const call = (id: string, text?: string): UiMessage => ({ id, role: "assistant", content: [...(text ? [{ type: "text" as const, text }] : []), { type: "toolCall", id, name: "bash", argumentsText: '{"command":"pwd"}' }] });
const result = (id: string, isError = false): UiMessage => ({ id: `${id}-result`, role: "toolResult", toolCallId: id, isError, durationMs: 100, content: [{ type: "text", text: "first\nsecond\n" }] });

test("labels keep the preceding explanation across calls but reset at turn boundaries", () => {
	const labels = commandPhaseLabels([user("u"), call("a", "实现校验"), result("a"), call("b"), call("c", "验证合法输入"), user("v"), call("d")]);
	expect([...labels]).toEqual([["a", "实现校验"], ["b", "实现校验"], ["c", "验证合法输入"]]);
});
test("one complete summary per turn, with measured duration and actual output lines", () => {
	const messages = [user("u"), call("a"), result("a"), call("b"), result("b"), user("v"), call("c"), result("c")];
	expect([...commandTurnSummaries(messages, false)]).toEqual([
		["b", { commands: 2, failed: 0, skipped: 0, lines: 4, durationMs: 200 }],
		["c", { commands: 1, failed: 0, skipped: 0, lines: 2, durationMs: 100 }],
	]);
	expect([...commandTurnSummaries(messages, true).keys()]).toEqual(["b"]);
});
test("a successful retry does not erase failed attempts; missing results never pass", () => {
	const summary = commandTurnSummaries([user("u"), call("a"), result("a", true), call("b"), result("b"), call("c")], false).get("c");
	expect(summary).toEqual({ commands: 3, failed: 1, skipped: 1 });
});
test("truncated output and missing duration omit estimates; auto-reminders do not split a turn", () => {
	const incomplete = result("a"); incomplete.durationMs = undefined; incomplete.content = [{ type: "text", text: "partial", truncated: true }];
	const reminder = { ...user("reminder"), origin: "auto-reminder" as const };
	expect(commandTurnSummaries([user("u"), call("a"), incomplete, reminder, call("b"), result("b")], false).get("b")).toEqual({ commands: 2, failed: 0, skipped: 0 });
});
