import { expect, test } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { repeatedAssistantErrors } from "../../web/src/assistant-error-presentation.js";

const error = (id: string, errorMessage = "Request timed out.", content: UiMessage["content"] = []): UiMessage =>
	({ id, role: "assistant", content, errorMessage });

test("adjacent identical error-only replies share one visible message", () => {
	const messages = [error("a"), error("b"), error("c"), error("d")];
	const { counts, hidden } = repeatedAssistantErrors(messages);
	expect([...counts]).toEqual([["a", 4]]);
	expect([...hidden]).toEqual([["b", "a"], ["c", "a"], ["d", "a"]]);
	expect(messages).toHaveLength(4);
});

test("other content, different errors, and turn boundaries stop the fold", () => {
	const messages: UiMessage[] = [
		error("a"),
		error("b", "Other error"),
		error("c", "Other error", [{ type: "text", text: "Partial answer" }]),
		error("d"),
		{ id: "u", role: "user", content: [{ type: "text", text: "again" }] },
		error("e"),
		error("f"),
	];
	const { counts, hidden } = repeatedAssistantErrors(messages, new Set([6]));
	expect(counts.size).toBe(0);
	expect(hidden.size).toBe(0);
});
