import { expect, it } from "vitest";
import { conversationWait } from "../../web/src/waiting-indicator.js";
import type { UiMessage } from "../../server/protocol.js";
const user: UiMessage = { id: "u", role: "user", content: [] };
const tool: UiMessage = { id: "a", role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", argumentsText: '{"command":"npm test"}' }] };
const result: UiMessage = { id: "r", role: "toolResult", toolCallId: "t", toolName: "bash", content: [] };
const empty = new Map();
const thinking = (key: string) => ({ key, label: "waitThinking", delay: 300 });
// Codex-style (remove-wait-status-live-running): running tools are represented by their
// live streaming row, so tool phases return null; only silent non-tool gaps get Thinking.
it("fills the just-sent gap with a minimal Thinking stage and ignores old turns", () => {
	expect(conversationWait([user], empty)).toEqual(thinking("u"));
	expect(conversationWait([tool, result, user], empty)).toEqual(thinking("u"));
	expect(conversationWait([], empty)).toBeNull();
});
it("keeps a Thinking stage after visible text while native lifecycle still runs", () => {
	for (const content of [
		[{ type: "text", text: "Now I will update the domain model." }],
		[{ type: "text", text: "Next step" }, { type: "thinking", thinking: "" }],
		[{ type: "text", text: "", truncated: true }],
	]) {
		expect(conversationWait([user, tool, result, { id: "next", role: "assistant", content }], empty)).toEqual(thinking("next"));
	}
});
it("visible thinking retains its own indicator, empty thinking gets a Thinking stage", () => {
	expect(conversationWait([user, { id: "next", role: "assistant", content: [{ type: "thinking", thinking: "Reasoning" }] }], empty)).toBeNull();
	expect(conversationWait([user, { id: "next", role: "assistant", content: [{ type: "thinking", thinking: "" }] }], empty)).toEqual(thinking("next"));
});
it("never narrates tool phases: running, completed and read results all defer to the live row", () => {
	expect(conversationWait([user, tool], empty)).toBeNull();
	expect(conversationWait([user, tool], new Map([["t", {}]]))).toBeNull();
	expect(conversationWait([user, tool, result], empty)).toBeNull();
	expect(conversationWait([user, tool, { ...result, toolName: "read" }], empty)).toBeNull();
});
it("does not revive long test/build commands as waiting labels", () => {
	for (const command of ['echo "npm test"', 'echo "example; npm test"', 'cat build.ts', 'sed -n "1,4p" tests.ts', "npm run build"]) {
		expect(conversationWait([user, { ...tool, content: [{ type: "toolCall", id: "t", name: "bash", argumentsText: JSON.stringify({ command }) }] }], empty)).toBeNull();
	}
});
it("defers SSH commands and file reads to their live rows too", () => {
	const command = { ...tool, content: [{ type: "toolCall", id: "t", name: "remote_command", argumentsText: '{"command":"npm test"}' }] };
	expect(conversationWait([user, command], empty)).toBeNull();
	expect(conversationWait([user, { ...result, toolName: "remote_read" }], empty)).toBeNull();
});
