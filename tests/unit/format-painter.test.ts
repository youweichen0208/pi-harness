import { expect, it } from "vitest";
import { declare, isEmptySample, canReplaceBlockTag, mergeBlockFormat, paintedBlockStyle, sampleFormat, splitStyle } from "../../web/src/format-painter.js";

it("splits one flat style string into inline and block domains", () => {
	const { inline, block } = splitStyle("font-size: 13px; color: rgb(1, 2, 3); text-align: center; line-height: 1.5");
	expect(declare(inline)).toBe("font-size: 13px; color: rgb(1, 2, 3)");
	expect(declare(block)).toBe("text-align: center; line-height: 1.5");
});

it("drops properties the document format would discard, so painting cannot outrun saving", () => {
	// `cleanStyle` accepts neither of these, so a sample must never carry them.
	const { inline, block } = splitStyle("letter-spacing: 2px; margin-top: 8px; font-size: 15px");
	expect(declare(inline)).toBe("font-size: 15px");
	expect(declare(block)).toBe("");
});

it("keeps a heading tag but flattens any other tag to paragraph", () => {
	expect(sampleFormat("", "H2").tag).toBe("h2");
	expect(sampleFormat("", "BLOCKQUOTE").tag).toBe("p");
	expect(sampleFormat("", "TD").tag).toBe("p");
});

it("block formatting replaces rather than merges, so an absent property resets the target", () => {
	// Source carries alignment but no line-height: the target's line-height must go.
	expect(mergeBlockFormat("text-align: right; line-height: 2", { "text-align": "center" })).toBe("text-align: center");
	expect(mergeBlockFormat("text-align: right; line-height: 2", { "text-align": "center", "line-height": "1.5" })).toBe("text-align: center; line-height: 1.5");
	expect(mergeBlockFormat("line-height: 2", {})).toBe("");
});

it("paints exactly the sampled block declarations, never the target's leftovers", () => {
	const sample = sampleFormat("text-align: center; line-height: 1.5; color: rgb(1, 2, 3)", "p");
	expect(paintedBlockStyle(sample)).toBe("text-align: center; line-height: 1.5");
});

it("copies paragraph and heading types in both directions while preserving structural containers", () => {
	expect(canReplaceBlockTag("P", "h2")).toBe(true);
	expect(canReplaceBlockTag("TD", "h3")).toBe(false);
	// Paragraph and heading levels are formats; table cells remain structural.
	expect(canReplaceBlockTag("H2", "p")).toBe(true);
	expect(canReplaceBlockTag("H2", "h3")).toBe(true);
	expect(canReplaceBlockTag("P", "p")).toBe(false);
});

it("reports an empty sample so the toolbar can disable the button instead of failing silently", () => {
	expect(isEmptySample(sampleFormat("", "P"))).toBe(true);
	expect(isEmptySample(sampleFormat("font-size: 13px", "P"))).toBe(false);
});
