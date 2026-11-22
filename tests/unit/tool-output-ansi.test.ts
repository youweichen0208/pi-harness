import { describe, it, expect } from "vitest";
import { serializeMessage } from "../../server/serialize.js";
import { toolOutputUpdate } from "../../server/tool-output.js";
import { stripAnsi } from "../../server/ansi.js";
import { mergeLiveToolOutput } from "../../web/src/live-tool-output.js";
import type { AgentMessage } from "../../server/serialize.js";
import type { UiContentBlock, UiMessage, UiTextBlock } from "../../server/protocol.js";

const CAP = 100_000;
/** Mirror of serialize.ts truncate(), used as the independent expectation. */
const truncate = (s: string) => (s.length <= CAP ? { text: s, truncated: false } : { text: `${s.slice(0, CAP)}\n\n… [truncated]`, truncated: true });

const coloured = (label: string) => `\u001b[32m${label}\u001b[0m\r\n\u001b[1;31mwarning:\u001b[0m 1 issue\r\n`;

function toolResult(text: string): AgentMessage {
	return { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 1 } as AgentMessage;
}

/** Narrow the first text block of a serialized toolResult without trusting a cast. */
function textBlock(message: UiMessage | null): UiTextBlock {
	expect(message).not.toBeNull();
	const block: UiContentBlock | undefined = message?.content[0];
	if (!block || block.type !== "text" || typeof block.text !== "string") throw new Error(`expected a text block, got ${block?.type}`);
	return { type: "text", text: block.text, truncated: block.truncated === true };
}

describe("ANSI is stripped on both display paths", () => {
	it("serializeMessage emits plain text for a coloured toolResult", () => {
		const block = textBlock(serializeMessage(toolResult(coloured("ok")), 0));
		expect(block.text).not.toContain("\u001b");
		expect(block.text).toContain("warning: 1 issue");
	});

	it("persisted text equals stripAnsi(raw) truncated — whole string, not a prefix", () => {
		// Escapes interleaved past the first chunk; the comparison covers the tail.
		const raw = Array.from({ length: 400 }, (_, i) => coloured(`line ${i}`)).join("");
		const block = textBlock(serializeMessage(toolResult(raw), 0));
		const expected = truncate(stripAnsi(raw));
		expect(block.text).toBe(expected.text);
		expect(block.truncated).toBe(expected.truncated);
	});

	it("live chunks accumulate to the same text as one strip of the whole output", () => {
		const raw = Array.from({ length: 2000 }, (_, i) => coloured(`progress ${i}`)).join("");
		let visible = "";
		// 8 KB chunks; tool_delta carries a cumulative snapshot (replace: true).
		for (let offset = 0; offset < raw.length; offset += 8192) {
			const update = toolOutputUpdate({ content: [{ type: "text", text: raw.slice(0, Math.min(offset + 8192, raw.length)) }] });
			if (!update) throw new Error("toolOutputUpdate returned no update");
			visible = mergeLiveToolOutput(visible, { ...update, delta: stripAnsi(update.delta) });
		}
		expect(visible).toBe(stripAnsi(raw));
		expect(visible).not.toContain("\u001b");
	});

	it("strips before truncating, so escapes never eat the cap", () => {
		const raw = "\u001b[31m".repeat(400) + "body".repeat(30);
		const block = textBlock(serializeMessage(toolResult(raw), 0));
		expect(block.truncated).toBe(false);
		expect(block.text).toBe("body".repeat(30));
	});
});
