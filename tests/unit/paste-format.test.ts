import { expect, it } from "vitest";
import { classifyPaste, renderNode, shouldOfferFold } from "../../web/src/paste-format.js";

const kinds = (text: string) => classifyPaste(text).map(node => node.type);

it("recognizes headings, fences, tables, lists and quotes", () => {
	expect(kinds("## 标题")).toEqual(["heading"]);
	expect(kinds("```python\nx = 1\n```")).toEqual(["code"]);
	expect(kinds("| a | b |\n| --- | --- |\n| 1 | 2 |")).toEqual(["table"]);
	expect(kinds("- one\n- two")).toEqual(["list"]);
	expect(kinds("> quoted")).toEqual(["quote"]);
});

it("converts delimited LaTeX but never guesses bare TeX", () => {
	expect(classifyPaste("$$\nx^2\n$$")).toEqual([{ type: "math", display: true, value: "x^2" }]);
	expect(classifyPaste("\\[\na+b\n\\]")).toEqual([{ type: "math", display: true, value: "a+b" }]);
	// The whole point: an undelimited formula stays literal.
	expect(classifyPaste("x^2 + a_i^{(j)}")).toEqual([{ type: "text", value: "x^2 + a_i^{(j)}" }]);
});

it("keeps an unterminated formula literal instead of failing", () => {
	expect(kinds("$$\nunclosed")).toEqual(["text"]);
});

it("never re-parses the inside of a code fence", () => {
	const nodes = classifyPaste("```sh\n# not a heading\n$$ not math $$\n```");
	expect(nodes).toEqual([{ type: "code", language: "sh", value: "# not a heading\n$$ not math $$" }]);
});

it("keeps an unterminated fence literal", () => {
	expect(kinds("```\nstill typing")).toEqual(["text"]);
});

it("recognizes notes in both marker dialects", () => {
	expect(classifyPaste("> [!NOTE]\n> 正文")).toEqual([{ type: "note", kind: "note", marker: "[!NOTE]", value: "正文" }]);
	expect(classifyPaste("> 提示：小心")).toEqual([{ type: "note", kind: "tip", marker: "[!TIP]", value: "小心" }]);
	expect(classifyPaste("> 注意：危险")[0]).toMatchObject({ kind: "warning", value: "危险" });
});

it("never rewrites the Chinese prefix into English in the saved source", () => {
	const [note] = classifyPaste("> 注：保留中文");
	expect(note.type).toBe("note");
	// The marker it serializes is Chinese-free, but the body survives untouched.
	expect(renderNode(note)).toBe("> [!NOTE]\n> 保留中文");
});

it("reads table alignment from the delimiter row", () => {
	const [table] = classifyPaste("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |") as any[];
	expect(table.align).toEqual(["left", "center", "right"]);
});

it("loses no input: every non-blank line survives classification", () => {
	const text = "## 标题\n\n正文\n\n```js\ncode\n```\n\n- a\n- b\n\n> quote";
	const rebuilt = classifyPaste(text).map(renderNode).join("\n\n");
	for (const line of text.split("\n").filter(l => l.trim())) expect(rebuilt).toContain(line.trim());
	expect(kinds(text)).toEqual(["heading", "text", "code", "list", "quote"]);
});

it("serializes a folded note as one details fragment with the note inside", () => {
	const markup = renderNode({ type: "foldedNote", kind: "tip", summary: "展开", value: "正文" });
	expect(markup.startsWith('<details data-rich-collapse=""><summary>展开</summary>')).toBe(true);
	expect(markup).toContain("> [!TIP]\n> 正文");
	expect(markup.trimEnd().endsWith("</details>")).toBe(true);
});

it("offers folding for long content but not for a short note", () => {
	expect(shouldOfferFold([{ type: "text", value: "短" }])).toBe(false);
	expect(shouldOfferFold([{ type: "note", kind: "note", marker: "[!NOTE]", value: "x".repeat(50) }])).toBe(false);
	expect(shouldOfferFold([{ type: "text", value: "x".repeat(2000) }])).toBe(true);
	expect(shouldOfferFold([{ type: "text", value: Array.from({ length: 30 }, () => "line").join("\n") }])).toBe(true);
	// A single short formula is never worth a fold.
	expect(shouldOfferFold([{ type: "math", display: true, value: "x".repeat(2000) }])).toBe(false);
});
