import { describe, expect, it } from "vitest";
import { latestOutputLine, mergeLiveToolOutput, outputSilenceSeconds, observeToolOutput, forgetOutputTimes } from "../../web/src/live-tool-output.js";

describe("mergeLiveToolOutput", () => {
	it("appends deltas and replaces on snapshot updates", () => {
		expect(mergeLiveToolOutput("", { delta: "a" })).toBe("a");
		expect(mergeLiveToolOutput("a", { delta: "b" })).toBe("ab");
		expect(mergeLiveToolOutput("ab", { delta: "xyz", replace: true })).toBe("xyz");
	});
});

describe("latestOutputLine", () => {
	it("returns the last non-empty line", () => {
		expect(latestOutputLine("one\ntwo\nthree")).toBe("three");
		expect(latestOutputLine("one\ntwo\n")).toBe("two");
		expect(latestOutputLine("one\n\n  \n")).toBe("one");
	});
	it("handles CRLF and surrounding whitespace", () => {
		expect(latestOutputLine("a\r\nb\r\n")).toBe("b");
		expect(latestOutputLine("  padded line  \n")).toBe("padded line");
	});
	it("returns empty string for empty output", () => {
		expect(latestOutputLine("")).toBe("");
		expect(latestOutputLine("\n\n")).toBe("");
	});
	it("caps very long lines from the tail", () => {
		const line = `prefix-${"x".repeat(400)}`;
		const latest = latestOutputLine(line);
		expect(latest.startsWith("…")).toBe(true);
		expect(latest.length).toBe(301);
		expect(latest.endsWith("x".repeat(10))).toBe(true);
	});
});

describe("outputSilenceSeconds", () => {
	it("does not invent receipt times and starts quiet feedback at 30 seconds", () => {
		expect(outputSilenceSeconds(undefined, 100000)).toBeUndefined();
		expect(outputSilenceSeconds(1000, 30999)).toBeUndefined();
		expect(outputSilenceSeconds(1000, 31000)).toBe(30);
		expect(outputSilenceSeconds(31000, 31000)).toBeUndefined();
		expect(outputSilenceSeconds(32000, 31000)).toBeUndefined();
	});
});

it("preserves timestamps across unchanged cumulative snapshots, resets on new output and forgets on disconnect", () => {
	const first = observeToolOutput(undefined, { toolName: "bash", delta: "a", receivedAt: 1000 });
	const same = observeToolOutput(first, { toolName: "bash", delta: "a", replace: true, receivedAt: 40000 });
	expect(same.lastOutputAt).toBe(1000);
	const next = observeToolOutput(same, { toolName: "bash", delta: "b", receivedAt: 41000 });
	expect(next.text).toBe("ab");
	expect(next.lastOutputAt).toBe(41000);
	const reset = forgetOutputTimes(new Map([["call", next]]));
	expect(reset.get("call")?.text).toBe("ab");
	expect(reset.get("call")?.lastOutputAt).toBeUndefined();
	expect(next.lastOutputAt).toBe(41000);
});

it("does not treat repeated capped cumulative snapshots as fresh output", () => {
	const update = { toolName: "bash", delta: "x".repeat(210000), replace: true, receivedAt: 1000 };
	const first = observeToolOutput(undefined, update);
	const repeated = observeToolOutput(first, { ...update, receivedAt: 40000 });
	expect(repeated.lastOutputAt).toBe(1000);
	expect(outputSilenceSeconds(repeated.lastOutputAt, 40000)).toBe(39);
});
