import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { UiSessionPersistence } from "../protocol.js";
import type { HistoryFileGuard } from "./history-file-guard.js";
import type { OmpPersistenceJournal } from "./persistence-journal.js";

/** Public native observers: never forward persistence errors or raw transcript data. */
export class OmpPersistence {
	private state: UiSessionPersistence = { failed: false };
	private unsubscribe: (() => void)[];
	constructor(session: AgentSession, changed: (state: UiSessionPersistence) => void, guard?: HistoryFileGuard, journal?: OmpPersistenceJournal) {
		const failed = (external = false) => {
				if (this.state.failed) return;
				this.state = { ...this.state, failed: true, ...(external ? { externallyModified: true } : {}) };
				try { if (session.sessionFile) journal?.record(session.sessionFile, external); }
				catch { this.state.recoveryStateUnavailable = true; }
				// Run within the native callback so retries and follow-ups cannot
				// proceed while the host is still receiving the failure frame.
				session.clearQueue({ forInterrupt: true });
				session.abortCompaction(); session.abortRetry(); session.abortBranchSummary();
				void session.abort({ reason: "Session persistence failed" }).catch(() => {});
				changed(this.snapshot());
		};
		this.unsubscribe = [
			...(guard ? [guard.onFailure(failed)] : []),
			session.sessionManager.onPersistenceError(() => failed()),
			session.sessionManager.onPersistenceNotice(notice => {
				this.state = { ...this.state, relocation: { reason: notice.reason, fromFile: notice.from, toFile: notice.to } };
				changed(this.snapshot());
			}),
		];
	}
	get failed() { return this.state.failed; }
	snapshot(): UiSessionPersistence { return { ...this.state, ...(this.state.relocation ? { relocation: { ...this.state.relocation } } : {}) }; }
	dispose() { for (const unsubscribe of this.unsubscribe) unsubscribe(); }
}

/** Read-only metadata and cancellation remain available after a durability failure. */
export function writesSession(command: string): boolean {
	return ["prompt", "steer", "follow_up", "set_model", "set_thinking_level", "set_session_name", "set_label", "fork", "branch", "navigate_tree", "compact", "bash", "new_session", "switch_session", "harness_rename_session", "harness_reload", "harness_cwd_event"].includes(command);
}
