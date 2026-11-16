import type { ServerMessage, UiState } from "../../server/protocol.js";

/** A checkpoint replaces all light fields and appends only durable messages. */
export function applySnapshotDelta(current: UiState | null, delta: Extract<ServerMessage, { type: "snapshot_delta" }>): UiState | null {
	if (!current || current.conversationId !== delta.conversationId || current.rev !== delta.baseRev) return current;
	return {
		// Optional fields absent on the JSON wire are cleared, not inherited.
		...delta.state,
		messages: delta.appended.length ? [...current.messages, ...delta.appended] : current.messages,
	};
}
