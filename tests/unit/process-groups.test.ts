import { expect, it } from "vitest";
import { processGroups } from "../../web/src/process-groups.js";
import type { UiMessage } from "../../server/protocol.js";
const text = (id: string, role: string, value = id): UiMessage => ({ id, role, content: [{ type: "text", text: value }] });
const call = (id: string, name = "bash"): UiMessage => ({ id, role: "assistant", content: [{ type: "toolCall", id: `tool-${id}`, name }] });
const result = (id: string, isError = false): UiMessage => ({ ...text(`result-${id}`, "toolResult"), toolCallId: `tool-${id}`, isError });
it("folds agent work per turn while retaining the user and final answer", () => {
	const messages = [text("u", "user"), text("intro", "assistant"), call("r", "read"), result("r"), call("b"), result("b"), text("answer", "assistant")];
	const original = JSON.stringify(messages);
	const { groups, members } = processGroups(messages, false);
	expect(groups.size).toBe(1);
	expect(groups.get("intro")).toMatchObject({ calls: 2, reads: 1, commands: 1, running: false, failed: false });
	expect(members.has("u")).toBe(false);
	expect(members.has("answer")).toBe(false);
	expect(JSON.stringify(messages)).toBe(original);
});
it("keeps recovery, errors and system events outside the disclosure", () => {
	const recovery = { ...text("recover", "assistant"), toolText: { incidentId: "incident", attempt: 1 } };
	const error = { ...text("error", "assistant"), stopReason: "aborted" };
	const messages = [call("a"), result("a", true), recovery, text("system", "system"), call("b"), error];
	const { groups, members } = processGroups(messages, false);
	expect(groups.get("a")?.failed).toBe(true);
	for (const id of ["recover", "error", "system"]) expect(members.has(id)).toBe(false);
});
it("uses observed timing only and marks only the latest segment running", () => {
	const thinking: UiMessage = { id: "think", role: "assistant", content: [{ type: "thinking", thinking: "check", durationMs: 3100 }] };
	const { groups } = processGroups([call("old"), result("old"), text("u", "user"), thinking, call("new", "edit")], true);
	expect(groups.get("old")?.running).toBe(false);
	expect(groups.get("think")).toMatchObject({ running: true, thinkingMs: 3100, edits: 1 });
	expect(processGroups([call("unknown")], false).groups.get("unknown")?.thinkingMs).toBe(0);
});
it("does not collapse plain replies or mix consecutive user requests", () => {
	expect(processGroups([text("u", "user"), text("a", "assistant")], false).groups.size).toBe(0);
	expect(processGroups([call("a"), text("u", "user"), call("b")], false).groups.size).toBe(2);
});
