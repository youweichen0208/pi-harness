import { expect, it } from "vitest";
import { appendCommandOutput } from "../../server/omp/commands.js";
import type { UiCommandOutput } from "../../server/protocol.js";

it("bounds hostile console output without changing earlier records or hiding truncation", () => {
	const original: UiCommandOutput[] = [{ id: "first", timestamp: 1, text: "retain literal <script> and /tool text" }];
	const text = "x".repeat(1024 * 1024);
	let outputs = appendCommandOutput(original, { id: "large", timestamp: 2, text });
	expect(original).toHaveLength(1);
	expect(outputs[0]).toBe(original[0]);
	expect(outputs.at(-1)?.truncated).toBe(true);
	expect(outputs.at(-1)?.text.length).toBeLessThan(text.length);
	for (let i = 0; i < 50; i++) outputs = appendCommandOutput(outputs, { id: `large-${i}`, timestamp: i + 3, text });
	expect(outputs.reduce((sum, output) => sum + output.text.length, 0)).toBeLessThanOrEqual(256 * 1024);
	expect(outputs.at(-1)?.id).toBe("large-49");
	for (let i = 0; i < 50; i++) outputs = appendCommandOutput(outputs, { id: `small-${i}`, timestamp: i + 100, text: "small" });
	expect(outputs).toHaveLength(20);
	expect(outputs.at(-1)?.id).toBe("small-49");
});

it("removes terminal formatting while preserving literal text and complete Unicode at the display boundary", () => {
	const outputs = appendCommandOutput([], { id: "ansi", timestamp: 1, text: "\u001b[32m<script>literal</script>\u001b[39m\n/tool" });
	expect(outputs[0].text).toBe("<script>literal</script>\n/tool");
	const boundary = appendCommandOutput([], { id: "unicode", timestamp: 2, text: "x".repeat(64 * 1024 - 1) + "😀" });
	expect(boundary[0].text.endsWith("x")).toBe(true);
	expect(boundary[0].truncated).toBe(true);
});
