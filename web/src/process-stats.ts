/** What one process list did, for its one-line header (Tool Group design). */
export interface ProcessStats {
	commands: number;
	searches: number;
	failed: number;
	running: boolean;
	/** A backgrounded command still runs after the turn settled: it keeps the
	 *  group open and its own row live, but never the header/Thought shimmer. */
	backgroundRunning: boolean;
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

/** A run-state command counts toward the group's live header only while the
 *  turn is still working; a background task that outlives the turn (dev server,
 *  watcher) must not keep the settled group's title and Thought shimmering. */
export function tallyRunningCommand(stats: ProcessStats, background: boolean, turnLive: boolean) {
	if (background && !turnLive) stats.backgroundRunning = true;
	else stats.running = true;
}

/** Success follows the latest attempts; later unrelated work cannot clear a failure. */
export function processGroupState(stats: ProcessStats): "run" | "err" | "empty" | "ok" {
	return stats.running ? "run" : stats.failed ? "err" : stats.skipped ? "empty" : "ok";
}

export function emptyProcessStats(): ProcessStats {
	return { commands: 0, searches: 0, failed: 0, running: false, backgroundRunning: false, live: false, skipped: true, thoughtMs: 0, thinking: 0, toolIds: [], outcomes: [], continued: false };
}
