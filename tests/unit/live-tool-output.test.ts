import { describe, expect, it } from "vitest";
import { latestOutputLine, mergeLiveToolOutput } from "../../web/src/live-tool-output.js";

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
