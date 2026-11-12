import type { UiMessage } from "../../server/protocol.js";

/** Hide retired built-in results, without suppressing third-party tools named plan. */
export function withoutRetiredPlans(messages: UiMessage[]): UiMessage[] {
	const ids = new Set(messages.filter(message => message.role === "toolResult" && message.toolName === "plan" && (message.planSnapshot || message.content.some(block => block.type === "text" && typeof block.text === "string" && /^Plan [\da-f-]+, revision \d+: (?:active|completed|cancelled|failed)\.$/i.test(block.text.trim())))).map(message => message.toolCallId));
	if (!ids.size) return messages;
	return messages.flatMap(message => {
		if (message.role === "toolResult" && ids.has(message.toolCallId)) return [];
		if (message.role !== "assistant") return [message];
		const content = message.content.filter(block => block.type !== "toolCall" || (typeof block.id !== "string" || !ids.has(block.id)));
		return content.length === message.content.length ? [message] : content.length || message.errorMessage ? [{ ...message, content }] : [];
	});
}
