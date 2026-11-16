import { expect, it } from "vitest";
import type { ServerMessage, UiState } from "../../server/protocol.js";
import { applySnapshotDelta } from "../../web/src/snapshot-delta.js";

function initial(): UiState {
	return {
		clientId: "client", cwd: "/fixture", sessionId: "session", conversationId: "chat", cwdEvents: [], rev: 1, version: 1,
		messages: [{ id: "user", role: "user", content: [{ type: "text", text: "Continue" }] }], streamingMessage: null,
		isStreaming: false, model: null, thinkingLevel: "off", availableThinkingLevels: [], queue: { steering: [], followUp: [] },
		tools: [], piConfigured: true, piAgentInstalled: true,
		stats: { totalMessages: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, contextUsage: { tokens: null, contextWindow: 0, percent: null } },
	};
}
function checkpoint(): Extract<ServerMessage, { type: "snapshot_delta" }> {
	const { messages: _, ...state } = initial();
	// Undefined optional properties disappear on the actual JSON wire.
	return JSON.parse(JSON.stringify({ type: "snapshot_delta", conversationId: "chat", baseRev: 1, rev: 2,
		appended: [], state: { ...state, rev: 2, version: 2, errorMessage: undefined, recovery: undefined, sessionPersistence: undefined } }));
}
it("clears optional status omitted from a complete light checkpoint instead of retaining an old error", () => {
	const current: UiState = { ...initial(), errorMessage: "Previous run interrupted", sessionPersistence: { failed: true }, recovery: { retry: { id: "old", phase: "waiting", attempt: 1, maxAttempts: 2, remainingMs: 100, error: "fixture" } } };
	const next = applySnapshotDelta(current, checkpoint());
	expect(next?.errorMessage).toBeUndefined();
	expect(next?.sessionPersistence).toBeUndefined();
	expect(next?.recovery).toBeUndefined();
	expect(next?.messages).toBe(current.messages);
	expect(current.errorMessage).toBe("Previous run interrupted");
});
it("appends history without changing the prior checkpoint and refuses a gap or another conversation", () => {
	const current = initial(), delta = checkpoint();
	delta.appended = [{ id: "answer", role: "assistant", content: [{ type: "text", text: "Done" }] }];
	const next = applySnapshotDelta(current, delta);
	expect(next?.messages.map(message => message.id)).toEqual(["user", "answer"]);
	expect(current.messages).toHaveLength(1);
	expect(applySnapshotDelta(current, { ...delta, baseRev: 0 })).toBe(current);
	expect(applySnapshotDelta(current, { ...delta, conversationId: "other" })).toBe(current);
});
