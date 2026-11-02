import { expect, test } from "vitest";
import { answerHistory, parseAnswerSummary } from "../../web/src/answer-history.js";
import type { UiMessage } from "../../server/protocol.js";

const answer = "Q1 部署：其他 · 本地：保留原端口\nQ2 目标：(a) 文档\n\n补充说明\n第二行";
const message = (id: string, role: "user" | "assistant", text: string): UiMessage => ({ id, role, timestamp: 1, content: [{ type: "text", text }] });
test("answer summary preserves custom answers and multiline notes", () => {
	expect(parseAnswerSummary(answer)).toEqual({ items: [
		{ id: "Q1", title: "部署", answer: "其他 · 本地：保留原端口" },
		{ id: "Q2", title: "目标", answer: "(a) 文档" },
	], note: "补充说明\n第二行" });
	for (const text of ["普通内容\n" + answer, "```\n" + answer + "\n```", "Q1 单个问题：答案", "Q1 问题：a\nQ1 重复：b"]) expect(parseAnswerSummary(text)).toBeNull();
});
test("history folds whole answer rounds while keeping the latest two complete", () => {
	const messages = Array.from({ length: 4 }, (_, i) => [message(`u${i}`, "user", answer), message(`a${i}`, "assistant", `完整回复 ${i}`)]).flat();
	const history = answerHistory(messages);
	expect(history.groups).toEqual([{ ids: ["u0", "a0", "u1", "a1"], count: 2 }]);
	expect(history.protectedIds.size).toBe(8);
});
test("ordinary user messages separate groups and are not hidden or protected", () => {
	const messages = [message("u0", "user", answer), message("a0", "assistant", "正文"), message("plain", "user", "普通提问"), message("plain-reply", "assistant", "普通回复"), ...Array.from({ length: 3 }, (_, i) => [message(`u${i + 1}`, "user", answer), message(`a${i + 1}`, "assistant", "正文")]).flat()];
	const history = answerHistory(messages);
	expect(history.groups).toEqual([{ ids: ["u0", "a0"], count: 1 }, { ids: ["u1", "a1"], count: 1 }]);
	expect(history.protectedIds.has("plain")).toBe(false);
	expect(history.protectedIds.has("plain-reply")).toBe(false);
});
