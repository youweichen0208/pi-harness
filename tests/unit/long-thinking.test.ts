import { describe, it, expect } from "vitest";
import { thinkingOnlySince } from "../../web/src/long-thinking.js";
import type { UiMessage } from "../../server/protocol.js";
const user: UiMessage = { id: "u", role: "user", timestamp: 1000, content: [{ type: "text", text: "去掉目录" }] };
const thinking: UiMessage = { id: "s", role: "assistant", timestamp: 2000, content: [{ type: "thinking", thinking: "两种解读…" }] };
describe("thinking-only turn", () => {
	it("starts at the user message while only thinking streams", () => {
		expect(thinkingOnlySince([user], thinking)).toBe(1000);
	});
	it("clears once the turn produces text or a tool call", () => {
		expect(thinkingOnlySince([user], { ...thinking, content: [...thinking.content, { type: "text", text: "我先问一下" }] })).toBeUndefined();
		const tool: UiMessage = { id: "a", role: "assistant", content: [{ type: "toolCall", id: "c", name: "read" }] };
		expect(thinkingOnlySince([user, tool], thinking)).toBeUndefined();
	});
	it("ignores blank text and earlier turns", () => {
		const earlier: UiMessage = { id: "e", role: "assistant", content: [{ type: "text", text: "旧回复" }] };
		expect(thinkingOnlySince([earlier, user], { ...thinking, content: [...thinking.content, { type: "text", text: "  " }] })).toBe(1000);
	});
	it("needs a streaming message with thinking", () => {
		expect(thinkingOnlySince([user], null)).toBeUndefined();
		expect(thinkingOnlySince([user], { ...thinking, content: [] })).toBeUndefined();
	});
});
