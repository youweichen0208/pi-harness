import { expect, test } from "vitest";
import type { UiMessage, UiCodemodeDetails } from "../../server/protocol.js";
import { codemodeRecords, currentCodemodeGroups } from "../../web/src/codemode-records.js";
import { TOOL_TEXT_CONTINUE_PROMPT } from "../../server/tool-text.js";
const user: UiMessage = { id: "u", role: "user", content: [{ type: "text", text: "Do work" }] };
const assistant: UiMessage = { id: "a", role: "assistant", content: [{ type: "toolCall", id: "cm", name: "codemode", argumentsText: "{}" }] };
const details = (count = 2): UiCodemodeDetails => ({ calls: Array.from({ length: count }, (_, i) => ({ id: "cm/?", name: i ? "models.classify" : "read", args: "{}", status: "running" })), totalCalls: count });
const result = (codemode = details()): UiMessage => ({ id: "r", role: "toolResult", toolCallId: "cm", toolName: "codemode", isError: false, content: [], codemode });

test("repeated temporary IDs use stable append positions across completion, without double counting", () => {
	const live = details();
	const initial = codemodeRecords(live, undefined, false);
	expect(initial.calls.map(c => c.key)).toEqual([0, 1]);
	live.calls[0] = { ...live.calls[0], id: "cm/real", status: "ok" };
	const completed = codemodeRecords(live, { complete: true, calls: [{ id: "cm/real", name: "read", status: "ok" }] }, false);
	expect(completed.calls).toHaveLength(2); expect(completed.calls.map(c => c.key)).toEqual([0, 1]);
});

test("retains partial failure, retries and cancellation while leaving outer success intact", () => {
	const data = details(4);
	data.calls.forEach((call, i) => { call.status = (["error", "ok", "cancelled", "running"] as const)[i]; });
	const groups = currentCodemodeGroups([user, assistant, result(data)], null, false);
	expect(groups[0].status).toBe("completed");
	expect(groups[0].calls.map(c => c.status)).toEqual(["error", "ok", "cancelled", "unfinished"]);
});

test("request boundaries preserve auto reminders, exclude old calls and deduplicate streaming message", () => {
	const reminder: UiMessage = { ...user, id: "reminder", origin: "auto-reminder" };
	expect(currentCodemodeGroups([user, assistant, reminder], assistant, true)).toHaveLength(1);
	const leak: UiMessage = { id: "leak", role: "assistant", content: [{ type: "text", text: '<invoke name="read"><parameter name="path">a</parameter></invoke>' }] };
	const recovery: UiMessage = { ...user, id: "recover", content: [{ type: "text", text: TOOL_TEXT_CONTINUE_PROMPT }] };
	expect(currentCodemodeGroups([user, assistant, leak, recovery], null, true)).toHaveLength(1);
	expect(currentCodemodeGroups([user, assistant, { ...user, id: "u2" }], null, true)).toEqual([]);
});

test("live deltas, nested fallback, missing terminal metadata and explicit abort stay distinct", () => {
	const activity = { liveOutputs: new Map([["cm", { codemode: details() }]]) };
	expect(currentCodemodeGroups([user, assistant], null, true, activity)[0].status).toBe("running");
	expect(currentCodemodeGroups([user, assistant], null, false, activity)[0].status).toBe("unfinished");
	expect(currentCodemodeGroups([user, { ...assistant, stopReason: "aborted" }], null, false, activity)[0].status).toBe("cancelled");
	const old: UiMessage = { ...result(), codemode: undefined, nestedCalls: { complete: false, calls: [{ id: "x", name: "bash", status: "unfinished" }] } };
	expect(currentCodemodeGroups([user, assistant, old], null, false)[0]).toMatchObject({ countKnown: false, incompleteHistory: true, calls: [{ status: "unfinished" }] });
	const statuses = new Map([["nested", { toolCallId: "nested", parentToolCallId: "cm", toolName: "read", isError: false, running: true, conversationId: "one" }]]);
	expect(currentCodemodeGroups([user, assistant], null, true, { toolStatuses: statuses }, "one")[0].calls).toHaveLength(1);
	expect(currentCodemodeGroups([user, assistant], null, true, { toolStatuses: statuses }, "two")[0].calls).toHaveLength(0);
});

test("transmission omission and display folding remain separate, including empty scripts", () => {
	const data = details(256); data.totalCalls = 300;
	const group = currentCodemodeGroups([user, assistant, result(data)], null, false)[0];
	expect(group).toMatchObject({ totalCalls: 300, omitted: 44, countKnown: true });
	expect(group.calls).toHaveLength(256);
	expect(currentCodemodeGroups([user, assistant, result(details(0))], null, false)[0]).toMatchObject({ status: "completed", totalCalls: 0, calls: [] });
	expect(currentCodemodeGroups([user], null, false)).toEqual([]);
});
