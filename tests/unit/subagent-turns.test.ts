import { expect, test } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { subagentTurns } from "../../web/src/subagent-turns.js";
const user = (id: string): UiMessage => ({ id, role: "user", content: [] });
const call = (id: string, action = "run"): UiMessage => ({ id, role: "assistant", content: [{ type: "toolCall", id, name: "subagent", argumentsText: JSON.stringify({ action, tasks: [{ sourceId: "repo:same", task: id }] }) }] });

test("groups across prose, results and reminders but never across user turns", () => {
	const first = call("a");
	const messages: UiMessage[] = [user("u"), first, { id: "result", role: "toolResult", toolCallId: "a", isError: true, content: [] }, { id: "prose", role: "assistant", content: [{ type: "text", text: "Retry" }] }, { ...user("reminder"), origin: "auto-reminder" }, call("b"), user("v"), call("c")];
	const groups = subagentTurns(messages);
	expect(groups.get("a")?.map(call => call.id)).toEqual(["a", "b"]);
	expect(groups.get("b")).toBe(groups.get("a"));
	expect(groups.get("c")?.map(call => call.id)).toEqual(["c"]);
	expect(first.content).toHaveLength(1);
});
test("keeps independent same-source calls, excludes discovery, tolerates partial args and duplicate streaming message", () => {
	const partial = call("partial"); partial.content = [{ type: "toolCall", name: "subagent", id: "partial", argumentsText: '{"action":' }];
	const groups = subagentTurns([user("u"), call("a"), call("sources", "sources"), call("inspect", "inspect"), partial, call("b"), call("b")]);
	expect([...groups.keys()]).toEqual(["a", "b"]);
	expect(groups.get("a")).toHaveLength(2);
});
