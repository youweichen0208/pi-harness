/** What one process list did, for its one-line header (Tool Group design). */
export interface ProcessStats {
	commands: number;
	reads: number;
	searches: number;
	failed: number;
	running: boolean;
	/** The turn is still working on this stretch (no prose after it yet). */
	live: boolean;
	/** Every tool was abandoned with its aborted message (issue #66). */
	skipped: boolean;
	thoughtMs: number;
	thinking: number;
	toolIds: string[];
	/** Latest command outcomes in display order. */
	outcomes: ("ok" | "err" | "run" | "skip")[];
	/** Prose or another step follows this list, so the turn moved on. */
	continued: boolean;
}

/** Success follows the latest attempts; later unrelated work cannot clear a failure. */
export function processGroupState(stats: ProcessStats): "run" | "err" | "empty" | "ok" {
	return stats.running ? "run" : stats.failed ? "err" : stats.skipped ? "empty" : "ok";
}

export function emptyProcessStats(): ProcessStats {
	return { commands: 0, reads: 0, searches: 0, failed: 0, running: false, live: false, skipped: true, thoughtMs: 0, thinking: 0, toolIds: [], outcomes: [], continued: false };
}
