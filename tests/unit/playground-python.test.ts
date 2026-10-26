import { expect, it } from "vitest";
import { pythonCandidates, PythonProbe, probePython } from "../../server/playground-python.js";
it("prefers an explicitly selected interpreter without treating its path as shell syntax", () => {
	expect(pythonCandidates({ PI_WEB_PYTHON: "/path with spaces/python", VIRTUAL_ENV: "/venv" })).toEqual([{ command: "/path with spaces/python", args: [] }]);
	expect(pythonCandidates({}, "win32").at(-1)).toEqual({ command: "py", args: ["-3"] });
});
it("caches runtime availability and supports a forced recheck", async () => {
	let calls = 0, now = 0;
	const probe = new PythonProbe(async () => ({ available: ++calls > 1 }), 60, () => now);
	expect((await probe.get()).available).toBe(false);
	await probe.get(); expect(calls).toBe(1);
	expect((await probe.get(true)).available).toBe(true);
	now = 61; await probe.get(); expect(calls).toBe(3);
});
it("a missing explicit interpreter degrades without falling back or throwing", async () => {
	const status = await probePython({ PI_WEB_PYTHON: "/does-not-exist/python" });
	expect(status.available).toBe(false); expect(status.reason).toBeTruthy();
});
