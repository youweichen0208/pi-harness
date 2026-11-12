import { expect, it } from "vitest";
import { withoutRetiredPlans } from "../../web/src/retired-plan.js";
import type { UiMessage } from "../../server/protocol.js";
it("hides old built-in calls and results while retaining accompanying text", () => {
	const messages: UiMessage[] = [
		{ id: "a", role: "assistant", content: [{ type: "toolCall", id: "p", name: "plan", argumentsText: '{}' }, { type: "text", text: "Finished" }] },
		{ id: "r", role: "toolResult", toolName: "plan", toolCallId: "p", content: [{ type: "text", text: "Plan 33213975-1864-4c1d-88c5-90532f82e3a4, revision 2: completed." }] },
	];
	expect(withoutRetiredPlans(messages)).toEqual([{ ...messages[0], content: [{ type: "text", text: "Finished" }] }]);
	expect(messages[0].content).toHaveLength(2);
});
it("preserves third-party plan output", () => {
	const messages: UiMessage[] = [{ id: "r", role: "toolResult", toolName: "plan", toolCallId: "p", content: [{ type: "text", text: "Third-party result" }] }];
	expect(withoutRetiredPlans(messages)).toBe(messages);
});
