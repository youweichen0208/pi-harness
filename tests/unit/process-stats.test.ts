import { expect, test } from "vitest";
import { emptyProcessStats, failureRecovered } from "../../web/src/process-stats.js";

const stats = (outcomes: ("ok" | "err" | "run" | "skip")[], continued = false) => ({ ...emptyProcessStats(), outcomes, continued, failed: outcomes.filter(item => item === "err").length, running: outcomes.includes("run") });

test("a failed call is recovered by a later success or by the turn moving on", () => {
	expect(failureRecovered(stats(["err", "ok"]))).toBe(true);
	expect(failureRecovered(stats(["ok", "err"], true))).toBe(true);
	expect(failureRecovered(stats(["ok", "err"]))).toBe(false);
	expect(failureRecovered(stats(["err", "run"]))).toBe(false);
	expect(failureRecovered(stats(["ok", "ok"]))).toBe(false);
});
