import { describe, expect, it } from "vitest";
import { NodeTerminalInput } from "../../server/node-terminal-input.js";

describe("terminal automatic replies", () => {
	it("separates focus reports without hiding typed or pasted input", () => {
		const input = new NodeTerminalInput();
		expect(input.userInput("\x1b[I\x1b[O")).toBe("");
		expect(input.userInput("pwd\r\x1b[O")).toBe("pwd\r");
		expect(input.userInput("\x1b[Iecho partial\x1b[O")).toBe("echo partial");
		for (const value of ["\x1b[A", "\x1b[1;2R", "\x1b[200~pwd\x1b[201~", "\x03", "\x1b[", ""]) {
			expect(input.userInput(value)).toBe(value);
		}
	});

	it("matches each cursor reply to one query, including every output split", () => {
		for (const query of ["\x1b[6n", "\x1b[?6n"]) {
			for (let split = 0; split <= query.length; split++) {
				const input = new NodeTerminalInput();
				input.observeOutput("prompt" + query.slice(0, split));
				input.observeOutput(query.slice(split) + "prompt");
				const response = query.includes("?") ? "\x1b[?12;80R" : "\x1b[12;80R";
				expect(input.userInput(response)).toBe("");
				expect(input.userInput(response)).toBe(response);
			}
		}
	});

	it("does not confuse extended replies, expired queries, or later keystrokes", () => {
		let now = 0;
		const input = new NodeTerminalInput(() => now);
		input.observeOutput("\x1b[?6n");
		expect(input.userInput("\x1b[1;2R")).toBe("\x1b[1;2R");
		input.observeOutput("\x1b[6n"); now = 5000;
		expect(input.userInput("\x1b[1;2R")).toBe("\x1b[1;2R");
		input.observeOutput("\x1b[6n");
		expect(input.userInput("a")).toBe("a");
		expect(input.userInput("\x1b[1;2R")).toBe("\x1b[1;2R");
	});
});
