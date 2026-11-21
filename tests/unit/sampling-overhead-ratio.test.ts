import { describe, it, expect } from "vitest";
import { samplingOverheadRatio } from "../lib/sampling-overhead-ratio.mjs";

describe("samplingOverheadRatio", () => {
	// The recorded host-latency JSON held exactly these two p50s; the old inline
	// formula rounded both sides first and reported 1.000 / pass.
	it("uses the unrounded ratio, so a real 8.3 % overhead survives rounding", () => {
		const { ratio, pass } = samplingOverheadRatio(624.668, 576.988);
		expect(ratio).toBe(1.083);
		expect(pass).toBe(true);
	});

	it("keeps the pass/fail direction either side of the 1.15 threshold", () => {
		// 663.2/576.988 = 1.1494 (pass); 664.4/576.988 = 1.1515 (fail). Both keep
		// their direction after rounding, so the check below is about `pass`
		// following the UNROUNDED ratio rather than the displayed one.
		expect(samplingOverheadRatio(663.2, 576.988)).toEqual({ ratio: 1.149, pass: true });
		expect(samplingOverheadRatio(664.4, 576.988)).toEqual({ ratio: 1.151, pass: false });
		// 663.8/576.988 = 1.1505: displays as 1.150 but fails — the unrounded
		// value, not the printed one, decides.
		expect(samplingOverheadRatio(663.8, 576.988)).toEqual({ ratio: 1.15, pass: false });
	});

	it("never passes without a control group", () => {
		expect(samplingOverheadRatio(100, 0)).toEqual({ ratio: null, pass: false });
	});

	it("reports a ratio of exactly 1 when both sides match", () => {
		expect(samplingOverheadRatio(100, 100)).toEqual({ ratio: 1, pass: true });
	});
});
