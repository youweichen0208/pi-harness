import type { UiMessage } from "../../server/protocol.js";
import { activeTool } from "./agent-activity.js";

export type WaitLabel = "waitThinking";
export interface WaitStage { key: string; label: WaitLabel; delay: number }

/** Codex-style running feedback (remove-wait-status-live-running): a running tool is
 * represented by its own live streaming row (latest output + timer), so the
 * trailing waiting indicator no longer narrates tool phases ("reading command results",
 * "reading files", "waiting for tests/build"). It only fills silent non-tool gaps — just
 * sent, empty thinking, or after visible text while the turn still runs — with one minimal
 * "Thinking" stage. Presentation only: text does not settle a run; the caller gates on the
 * native lifecycle. */
export function conversationWait(messages: readonly UiMessage[], completed: ReadonlyMap<string, unknown>): WaitStage | null {
	const userIndex = messages.findLastIndex(m => m.role === "user" && m.origin !== "auto-reminder" && m.origin !== "auto-recovery");
	const turn = messages.slice(userIndex + 1);
	// A running tool owns the running state through its live row.
	if (activeTool(messages, completed)) return null;
	const thinking = (key: string): WaitStage => ({ key, label: "waitThinking", delay: 300 });
	for (let i = turn.length - 1; i >= 0; i--) {
		const message = turn[i];
		// Tool results / completed calls: the live row already ran; no phase label.
		if (message.role === "toolResult") return null;
		if (message.role !== "assistant") continue;
		for (const block of [...message.content].reverse()) {
			if (block.type === "toolCall" && typeof block.id === "string") return null;
			if (block.type === "text" && ((typeof block.text === "string" && block.text.trim()) || block.truncated)) return thinking(message.id);
			if (block.type === "thinking") {
				if (typeof block.thinking === "string" && block.thinking.trim()) return null;
				if (message.content.some(b => b.type === "text" && (typeof b.text === "string" && b.text.trim() || b.truncated))) return thinking(message.id);
				if (message.content.some(b => b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim())) return null;
				return thinking(message.id);
			}
		}
	}
	const user = messages[userIndex];
	return user ? thinking(user.id) : null;
}
