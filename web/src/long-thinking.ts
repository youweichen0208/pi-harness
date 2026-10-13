import type { UiMessage } from "../../server/protocol.js";

/** Thinking-only stretch after which the composer offers to stop (#76). */
export const LONG_THINKING_MS = 2 * 60 * 1000;

function producedOutput(message: UiMessage): boolean {
	return message.content.some((block) => block.type === "toolCall" || block.type === "image"
		|| block.type === "text" && typeof (block as { text?: unknown }).text === "string" && !!(block as { text: string }).text.trim());
}

/**
 * When the running turn has so far produced only thinking — no reply text and
 * no tool call since the last user message — returns when that turn started.
 * The host never interrupts on its own; this only drives a user-facing notice.
 */
export function thinkingOnlySince(messages: readonly UiMessage[], streaming: UiMessage | null | undefined): number | undefined {
	if (!streaming || streaming.role !== "assistant") return undefined;
	if (!streaming.content.some((block) => block.type === "thinking")) return undefined;
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	const turn = [...messages.slice(lastUser + 1), streaming];
	if (turn.some((message) => message.role === "assistant" && producedOutput(message))) return undefined;
	return messages[lastUser]?.timestamp ?? turn.find((message) => message.timestamp)?.timestamp;
}
