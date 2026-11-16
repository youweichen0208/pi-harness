import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { UiRecovery } from "../protocol.js";

/** One tracker per native worker. IDs are checked beside the operation they stop. */
export class OmpRecovery {
	private state: UiRecovery = {};
	private retryDeadline = 0;
	private compactionKind?: "manual" | "auto";
	constructor(private publish: (state: UiRecovery) => void, private now = () => performance.now()) {}
	observe(event: AgentSessionEvent) {
		switch (event.type) {
			case "manual_compaction_start": case "auto_compaction_start":
				this.compactionKind = event.type === "manual_compaction_start" ? "manual" : "auto";
				this.state.compaction = { id: randomUUID(), reason: event.type === "manual_compaction_start" ? "manual" : event.reason };
				delete this.state.lastCompaction; break;
			case "manual_compaction_end": case "auto_compaction_end": {
				const active = this.state.compaction;
				if (!active || this.compactionKind !== (event.type === "manual_compaction_end" ? "manual" : "auto")) return;
				this.state.lastCompaction = { ...active,
					status: event.aborted ? "aborted" : event.skipped ? "skipped" : event.errorMessage ? "error" : "completed",
					tokensBefore: event.result?.tokensBefore,
					...(event.errorMessage && !event.skipped && !event.aborted ? { error: "OMP context maintenance failed." } : {}),
				};
				delete this.state.compaction; break;
			}
			case "auto_retry_start":
				this.retryDeadline = this.now() + event.delayMs;
				this.state.retry = { id: randomUUID(), phase: "waiting", attempt: event.attempt, maxAttempts: event.maxAttempts, error: "OMP request failed; retrying." }; break;
			case "agent_start":
				if (!this.state.retry) return;
				this.state.retry.phase = "running"; break;
			case "auto_retry_end": delete this.state.retry; break;
			default: return;
		}
		this.publish(this.snapshot());
	}
	snapshot(): UiRecovery {
		const snapshot = structuredClone(this.state);
		if (snapshot.retry) snapshot.retry.remainingMs = snapshot.retry.phase === "waiting" ? Math.max(0, this.retryDeadline - this.now()) : 0;
		return snapshot;
	}
	cancel(id: string, session: { abortCompaction(): void; abortRetry(): void }): boolean {
		if (id === this.state.compaction?.id) { session.abortCompaction(); return true; }
		if (id === this.state.retry?.id) { session.abortRetry(); return true; }
		return false;
	}
}

/** Re-sample a worker's duration without putting its clock on the browser wire. */
export function ageRecovery(state: UiRecovery | undefined, elapsed: number): UiRecovery | undefined {
	if (!state) return;
	return { ...state, ...(state.retry ? { retry: { ...state.retry, remainingMs: Math.max(0, (state.retry.remainingMs ?? 0) - elapsed) } } : {}) };
}
