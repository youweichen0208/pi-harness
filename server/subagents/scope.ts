type SessionIdentity = { getSessionId(): string };
type Lane = "steering" | "followUp";
type PendingScope = { text: string; workspaceId?: string };

const workspaces = new WeakMap<SessionIdentity, { sessionId: string; workspaceId?: string }>();

/** Selection belongs to the native session that consumed the user message,
 * never to whichever browser project happens to be visible now. */
export function getSubagentWorkspace(manager: SessionIdentity): string | undefined {
	const value = workspaces.get(manager);
	return value?.sessionId === manager.getSessionId() ? value.workspaceId : undefined;
}

/** No event subscriptions or native messages: prompt delivery owns this
 * tracker and discards it when the run settles. */
export function createSubagentPromptScope(manager: SessionIdentity) {
	const sessionId = manager.getSessionId();
	const pending: Record<Lane, PendingScope[]> = { steering: [], followUp: [] };
	let initialMessagePending = false;
	const bind = (workspaceId?: string) => {
		if (manager.getSessionId() === sessionId) workspaces.set(manager, { sessionId, workspaceId });
	};
	return {
		started(workspaceId?: string) {
			// SDK calls started before emitting this run's initial user message.
			// An identical prompt may already be queued during before_agent_start;
			// the initial message must not consume that queued prompt's scope.
			initialMessagePending = true;
			bind(workspaceId);
		},
		queued(lane: Lane, text: string, workspaceId?: string) {
			pending[lane].push({ text, workspaceId });
		},
		consume(text: string) {
			if (initialMessagePending) { initialMessagePending = false; return; }
			// Mirror the SDK's first matching text, steering before follow-up.
			for (const lane of ["steering", "followUp"] as const) {
				const index = pending[lane].findIndex(record => record.text === text);
				if (index < 0) continue;
				const [record] = pending[lane].splice(index, 1);
				bind(record.workspaceId);
				return;
			}
		},
		clearPending() { pending.steering.length = 0; pending.followUp.length = 0; },
	};
}
