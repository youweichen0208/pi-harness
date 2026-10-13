import { describe, expect, it } from "vitest";
import { conversationDisplayTitle } from "../../web/src/conversation-display-title.js";

describe("conversation display title", () => {
	it("localizes a completed unnamed greeting without changing a manual name", () => {
		expect(conversationDisplayTitle("hello", "hello", undefined, 2, "zh")).toBe("打招呼");
		expect(conversationDisplayTitle("hello", "hello", undefined, 1, "zh")).toBe("hello");
		expect(conversationDisplayTitle("hello", "hello", "My chat", 2, "zh")).toBe("My chat");
		expect(conversationDisplayTitle("hello", "hello", undefined, 2, "en")).toBe("hello");
		expect(conversationDisplayTitle("hello", "hello", undefined, 4, "zh", [
			{ id: "1", role: "user", content: [{ type: "text", text: "hello" }] },
			{ id: "2", role: "user", content: [{ type: "text", text: "审查最近的代码改动" }] },
		] as Parameters<typeof conversationDisplayTitle>[5])).toBe("审查最近的代码改动");
	});
});

it("skill invocations are titled by the skill name without the skill: prefix", () => {
	expect(conversationDisplayTitle("skill:grill-with-docs · 可以参照这个设计帮我写一下架构吗", undefined, undefined, 3, "zh")).toBe("grill-with-docs · 可以参照这个设计帮我写一下架构吗");
	expect(conversationDisplayTitle("skill:grill-with-docs · x", undefined, "我的命名", 3, "zh")).toBe("我的命名");
});
