import { expect, test } from "vitest";
import { isEmptyReply, userPreviewParts } from "../../web/src/collapsed-groups.js";
import type { UiMessage } from "../../server/protocol.js";

const skill = '<skill name="grill-with-docs" location="/skills/grill/SKILL.md">\nbody\n</skill>\n\n可以参照这个设计帮我写一下架构吗\n\n<file path="/Users/me/.pi-web/uploads/x/Hermes 设计包.docx">\n```\nbinary\n```\n</file>';

test("folded user rows show the skill, the question and file names, not wrappers", () => {
	const parts = userPreviewParts({ id: "u", role: "user", content: [{ type: "text", text: skill }] });
	expect(parts).toEqual({ skill: "grill-with-docs", text: "可以参照这个设计帮我写一下架构吗", files: ["Hermes 设计包.docx"] });
	const reference = userPreviewParts({ id: "r", role: "user", content: [{ type: "text", text: '看看这个\n\n<folder path="/srv/app" />' }] });
	expect(reference).toEqual({ text: "看看这个", files: ["app"] });
});

test("only replies without prose, thinking, tools or an error are empty", () => {
	const reply = (content: UiMessage["content"], extra: Partial<UiMessage> = {}): UiMessage => ({ id: "a", role: "assistant", content, ...extra });
	expect(isEmptyReply(reply([]))).toBe(true);
	expect(isEmptyReply(reply([{ type: "text", text: "  " }, { type: "thinking", thinking: "" }]))).toBe(true);
	expect(isEmptyReply(reply([{ type: "thinking", thinking: "plan" }]))).toBe(false);
	expect(isEmptyReply(reply([{ type: "toolCall", id: "t", name: "edit" }]))).toBe(false);
	expect(isEmptyReply(reply([], { errorMessage: "rate limited" }))).toBe(false);
	expect(isEmptyReply({ id: "u", role: "user", content: [] })).toBe(false);
});
