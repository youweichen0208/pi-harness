import { expect, test } from "vitest";
import { emptyProcessStats, processGroupState } from "../../web/src/process-stats.js";
const stats = (outcomes: ("ok" | "err" | "run" | "skip")[], continued = false) => ({ ...emptyProcessStats(), skipped: outcomes.every(s => s === "skip"), outcomes, continued, failed: outcomes.filter(item => item === "err").length, running: outcomes.includes("run") });
test("later unrelated success and prose never clear failures", () => {
	expect(processGroupState(stats(["err", "ok"]))).toBe("err");
	expect(processGroupState(stats(["ok", "err"], true))).toBe("err");
	expect(processGroupState(stats(["err", "run"]))).toBe("run");
	expect(processGroupState(stats(["ok", "ok"]))).toBe("ok");
});
test("successful latest attempts use the normal success state", () => {
	expect(processGroupState(stats(["ok"]))).toBe("ok");
	expect(processGroupState(stats(["skip"]))).toBe("empty");
});
