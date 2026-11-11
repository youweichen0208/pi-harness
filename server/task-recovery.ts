/**
 * Whether a failed step still counts as the turn's outcome.
 *
 * A failed tool call is not a failed task: the agent routinely retries it, or
 * exits with a different command that succeeds (a `sed -n` on a missing file
 * followed by an `rg` that works). Once a later step completes, the agent moved
 * past the error, so it belongs to exploring rather than to the outcome. Only a
 * failure with nothing completed after it is still live.
 *
 * Kept in its own module so the server (which derives the task status) and the
 * web layer (which derives the step phases) share one definition instead of two
 * copies that can drift apart and contradict each other in the same panel.
 */

/** Indexes of steps whose failure nothing came back from. */
export function unrecoveredFailures(steps: readonly { status: string }[]): number[] {
	const lastDone = steps.findLastIndex((step) => step.status === "done");
	return steps.reduce<number[]>((found, step, index) => (step.status === "failed" && index > lastDone ? [...found, index] : found), []);
}

/** True when the turn ended on a failure that nothing came back from. */
export function taskFailed(steps: readonly { status: string }[]): boolean {
	return unrecoveredFailures(steps).length > 0;
}
