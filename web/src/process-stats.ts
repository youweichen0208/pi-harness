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
	/** Tool outcomes in order, to tell a recovered failure from the one the turn stopped on. */
	outcomes: ("ok" | "err" | "run" | "skip")[];
	/** Prose or another step follows this list, so the turn moved on. */
	continued: boolean;
}

/** A failure counts as recovered once a later call succeeded or the turn went on past the group. */
export function failureRecovered(stats: ProcessStats): boolean {
	if (!stats.failed || stats.running) return false;
	const lastError = stats.outcomes.lastIndexOf("err");
	return stats.continued || stats.outcomes.slice(lastError + 1).includes("ok");
}

export function emptyProcessStats(): ProcessStats {
	return { commands: 0, reads: 0, searches: 0, failed: 0, running: false, live: false, skipped: true, thoughtMs: 0, thinking: 0, toolIds: [], outcomes: [], continued: false };
}
