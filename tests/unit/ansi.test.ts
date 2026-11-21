import { describe, it, expect } from "vitest";
import { stripAnsi } from "../../server/ansi.js";

const ANSI_LOG_LINE = "\u001b[32m" + "x".repeat(60) + "\u001b[0m\n";

describe("stripAnsi", () => {
	it("removes SGR colour codes and keeps the text", () => {
		expect(stripAnsi("\u001b[31mred\u001b[0m ✓")).toBe("red ✓");
	});

	it("removes C1 CSI sequences without requiring an extra [", () => {
		expect(stripAnsi("\u009b31mred\u009b0m")).toBe("red");
	});

	it("removes OSC sequences terminated by BEL", () => {
		expect(stripAnsi("a\u001b]0;title\u0007b")).toBe("ab");
	});

	it("removes erase-line escapes but keeps carriage returns", () => {
		expect(stripAnsi("a\r\u001b[Kb")).toBe("a\rb");
	});

	it("returns plain text unchanged", () => {
		expect(stripAnsi("plain")).toBe("plain");
	});

	it("stays cheap on a 1 MB coloured log", () => {
		const text = ANSI_LOG_LINE.repeat(1024 * 1024 / ANSI_LOG_LINE.length);
		const started = performance.now();
		for (let i = 0; i < 100; i++) stripAnsi(text);
		expect(stripAnsi(ANSI_LOG_LINE)).toBe("x".repeat(60) + "\n");
		expect(performance.now() - started).toBeLessThan(300);
	});
});
