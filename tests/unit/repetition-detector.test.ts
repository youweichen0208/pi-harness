import { describe, expect, it } from "vitest";
import { RepetitionDetector } from "../../server/repetition-detector.js";

function feed(text: string, channel: "text" | "thinking" = "text", width = 7): boolean {
	const detector = new RepetitionDetector(channel);
	for (let offset = 0; offset < text.length; offset += width) {
		if (detector.push(text.slice(offset, offset + width))) return true;
	}
	return false;
}

describe("RepetitionDetector", () => {
	it.each(["text", "thinking"] as const)("detects single-line, alternating and unbroken cycles in %s", channel => {
		for (const pattern of ["Emit.\n", "Emit.\nOk.\n.\n", "现在继续。", "."]) {
			for (const width of [1, 7, 257, 20_000]) expect(feed(pattern.repeat(2000), channel, width)).toBe(true);
		}
	});

	it("requires both a sufficient sample and continued repetition before latching", () => {
		const detector = new RepetitionDetector("thinking");
		expect(detector.push(".".repeat(1023))).toBe(false);
		expect(detector.push(".")).toBe(false);
		expect(detector.push(".".repeat(255))).toBe(false);
		expect(detector.push(".")).toBe(true);
		expect(detector.push("New output")).toBe(true);
		expect(detector.push("")).toBe(true);
	});

	it("checks within large deltas instead of relying on the number of events", () => {
		expect(feed("Emit.\n".repeat(1000), "text", 100_000)).toBe(true);
		expect(feed("Emit.\n".repeat(1000), "text", 1)).toBe(true);
	});

	it("handles CRLF split between deltas", () => {
		expect(feed("Emit.\r\nOk.\r\n.\r\n".repeat(1000), "text", 1)).toBe(true);
	});

	it("requires 20 cycles even for the longest supported pattern", () => {
		const pattern = "a".repeat(255) + "b";
		const detector = new RepetitionDetector("thinking");
		expect(detector.push(pattern.repeat(19))).toBe(false);
		expect(detector.push(pattern)).toBe(false);
		expect(detector.push(pattern)).toBe(true);
		expect(feed(("a".repeat(256) + "b").repeat(100), "thinking")).toBe(false);
	});

	it("does not flag empty output, whitespace, short repeats or tables with distinct rows", () => {
		expect(feed("")).toBe(false);
		expect(feed(" \n\t".repeat(10_000))).toBe(false);
		expect(feed("Emit.\n".repeat(30))).toBe(false);
		const rows = Array.from({ length: 500 }, (_, i) => `| Record ${i} | Value ${i * 37} | Result ${i % 11} |`).join("\n");
		expect(feed(rows)).toBe(false);
		const paragraphs = Array.from({ length: 200 }, (_, i) => `Step ${i}: inspect item ${i * 13}, then report its result ${i % 17}.`).join("\n");
		expect(feed(paragraphs, "thinking")).toBe(false);
	});

	it("does not confuse shared wording with exact cycles", () => {
		const detector = new RepetitionDetector("text");
		expect(detector.push(".".repeat(1024))).toBe(false);
		expect(detector.push(Array.from({ length: 256 }, (_, i) => String.fromCharCode(65 + i % 26)).join(""))).toBe(false);
	});

	it.each(["```", "~~~~", "   ```"])("excludes %s fences even across chunks and a full tail window", fence => {
		const code = `${fence}text\n${"Emit.\n".repeat(5000)}${fence}\nFinished.\n`;
		for (const width of [1, 5, 200_000]) expect(feed(code, "text", width)).toBe(false);
	});

	it("keeps unclosed code fences excluded and ignores shorter or invalid closing lines", () => {
		expect(feed("````text\n```\n" + "Emit.\n".repeat(3000))).toBe(false);
		expect(feed("```text\n```not a closer\n" + "Emit.\n".repeat(3000))).toBe(false);
		expect(feed("```text\n" + "x".repeat(30_000), "text", 1)).toBe(false);
	});

	it("resumes detection after closing a fence, including a longer indented closer", () => {
		const text = "```text\n" + "Emit.\n".repeat(2000) + "  ```` \t\n" + "Ok.\n".repeat(1000);
		expect(feed(text, "text", 1)).toBe(true);
	});

	it("breaks a repetition candidate at a fence rather than joining separated prose", () => {
		const detector = new RepetitionDetector("text");
		expect(detector.push(".".repeat(1024) + "\n")).toBe(false);
		expect(detector.push("```\nignored\n```\n" + ".".repeat(256))).toBe(false);
	});

	it("does not exclude reasoning just because it contains code fence markers", () => {
		expect(feed("```text\n" + "Emit.\n".repeat(1000), "thinking")).toBe(true);
	});

	it("keeps inline backticks and inline tildes eligible", () => {
		expect(feed("Use `x` and ~~y~~.\n".repeat(1000))).toBe(true);
	});

	it("eventually detects a loop following a long valid answer", () => {
		const answer = Array.from({ length: 1000 }, (_, i) => `Result ${i}: ${i * 17}.\n`).join("");
		expect(feed(answer + "Emit.\n".repeat(3000))).toBe(true);
	});
});
