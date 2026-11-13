import type { UiMessage } from "../../server/protocol.js";

/** Fold adjacent, error-only assistant messages for display; keep transcript data intact. */
export function repeatedAssistantErrors(messages: readonly UiMessage[], gapIndices: ReadonlySet<number> = new Set()) {
	const counts = new Map<string, number>();
	const hidden = new Map<string, string>();
	let head: UiMessage | undefined;
	for (const [index, message] of messages.entries()) {
		const errorOnly = message.role === "assistant" && message.origin !== "auto-reminder" &&
			!!message.errorMessage?.trim() &&
			message.content.every(block => block.type === "text" && typeof block.text === "string" && !block.text.trim());
		if (errorOnly && head && !gapIndices.has(index) && message.errorMessage === head.errorMessage) {
			counts.set(head.id, (counts.get(head.id) ?? 1) + 1);
			hidden.set(message.id, head.id);
		} else {
			head = errorOnly ? message : undefined;
		}
	}
	return { counts, hidden };
}
