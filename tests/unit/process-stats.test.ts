import { expect, test } from "vitest";
import { emptyProcessStats, processGroupState, tallyRunningCommand } from "../../web/src/process-stats.js";
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
test("a backgrounded command outliving the turn keeps the group open, not the header live", () => {
	const settled = { ...emptyProcessStats(), skipped: false };
	tallyRunningCommand(settled, true, false);
	expect(settled.running).toBe(false);
	expect(settled.backgroundRunning).toBe(true);
	expect(processGroupState(settled)).toBe("ok");
});
test("while the turn is live, background and foreground runs keep the live header", () => {
	const live = emptyProcessStats();
	tallyRunningCommand(live, true, true);
	expect(live.running).toBe(true);
	tallyRunningCommand(live, false, true);
	expect(live.backgroundRunning).toBe(false);
	expect(processGroupState(live)).toBe("run");
});
