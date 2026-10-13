import { expect, test } from "vitest";
import { NodeTerminalOutput } from "../../server/node-terminal-output.js";

test("PTY framing discards shell echo and handles every packet boundary", () => {
	const wire = "fixture$ printf 'BEGIN'; command; printf 'END'\r\nBEGIN\r\n你好\r\nsecond\r\n\r\nEND:0\r\nfixture$ ";
	for (let boundary = 1; boundary < wire.length; boundary++) {
		const capture = new NodeTerminalOutput("BEGIN", "END");
		const first = capture.push(wire.slice(0, boundary));
		if (first.result) continue;
		const second = capture.push(wire.slice(boundary));
		expect(second.result).toEqual({ output: "你好\r\nsecond\r\n", code: 0 });
		expect(first.display + second.display).toBe("你好\r\nsecond\r\nfixture$ ");
	}
});

test("PTY capture streams large output while retaining only bounded model output", () => {
	const capture = new NodeTerminalOutput("BEGIN", "END");
	expect(capture.push("\nBEGIN\n").display).toBe("");
	let displayed = 0;
	for (let i = 0; i < 100; i++) displayed += capture.push("x".repeat(1000)).display.length;
	expect(displayed).toBeGreaterThan(99000);
	const final = capture.push("\nEND:7\n");
	expect(final.result?.code).toBe(7);
	expect(final.result?.output).toContain("[输出已截断]");
	expect(Buffer.byteLength(final.result!.output)).toBeLessThan(65600);
});
