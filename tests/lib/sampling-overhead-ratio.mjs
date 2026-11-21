/** Sampling-overhead ratio for the host-latency benchmark.
 *
 * The benchmark used to compute `on/off` from ALREADY ROUNDED p50s, so any
 * difference below 0.6 % collapsed to `ratio === 1` and always passed. This
 * module takes RAW milliseconds and rounds for display only; `pass` always
 * uses the unrounded ratio.
 */

/**
 * @param {number} onMs  p50 round-trip with PI_SNAPSHOT_TIMINGS=1 (raw ms)
 * @param {number} offMs p50 round-trip with sampling off (raw ms)
 * @returns {{ ratio: number | null, pass: boolean }}
 */
export function samplingOverheadRatio(onMs, offMs) {
	// No control group means the overhead is unknown, not zero: never pass.
	if (!(offMs > 0) || typeof onMs !== "number" || !Number.isFinite(onMs)) return { ratio: null, pass: false };
	const ratio = onMs / offMs;
	// Round for display only; `pass` uses the unrounded value.
	return { ratio: Math.round(ratio * 1000) / 1000, pass: ratio <= 1.15 };
}
