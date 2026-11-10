import { expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { disclosureSpans, spansAreSafe, type SeriesNode } from "../../web/src/rich-disclosure.js";
const parse = (source: string): SeriesNode[] => unified().use(remarkParse).use(remarkGfm).parse(source).children.map((node: any) => ({ type: node.type, start: node.position.start.offset, end: node.position.end.offset, value: node.type === "html" ? node.value : undefined }));
const pair = (source: string) => spansAreSafe(source, parse(source), disclosureSpans(source, parse(source)));
/** The bug: a hand-written disclosure was cut into three top-level nodes. */
const reported = `第一组输出为 [32,64]；第二组内维度 128 与 64 不匹配。

<details>
<summary>展开</summary>

第一组输出为 [32,64]；第二组内维度 128 与 64 不匹配。
</details>

## 二、自动微分到底做了什么

考虑标量模型：
`;
it("reports the disclosure as three sibling nodes before pairing", () => {
	const types = parse(reported).map(node => node.type);
	expect(types).toEqual(["paragraph", "html", "paragraph", "html", "heading", "paragraph"]);
});
it("pairs opener, body and closer into one span covering the whole construct", () => {
	const spans = [...pair(reported).values()];
	expect(spans).toHaveLength(1);
	expect(reported.slice(spans[0].start, spans[0].end)).toBe("<details>\n<summary>展开</summary>\n\n第一组输出为 [32,64]；第二组内维度 128 与 64 不匹配。\n</details>");
	expect(spans[0].bare).toBe(true);
});
it("leftover per-node blocks still rebuild the source byte-for-byte", () => {
	// `prepareRichDocument` emits prefix + raw + suffix per block; the pairing must move
	// interior whitespace into `raw` rather than into `prefix`, or bytes are lost.
	const span = [...pair(reported).values()][0];
	const nodes = parse(reported);
	const blocks = nodes.flatMap(node => node.start >= span.start && node.end <= span.end ? [] : [{ start: node.start, end: node.end }]).concat([{ start: span.start, end: span.end }]).sort((a, b) => a.start - b.start);
	let end = 0;
	const rebuilt = blocks.map(block => { const prefix = reported.slice(end, block.start); end = block.end; return prefix + reported.slice(block.start, block.end); }).join("");
	expect(rebuilt + reported.slice(end)).toBe(reported);
});
it("leaves an unmatched closer in its own node", () => {
	const source = "正文。\n\n</details>\n\n结尾。\n";
	expect(pair(source).size).toBe(0);
});
it("leaves an opener that never closes editable", () => {
	const source = "正文。\n\n<details>\n<summary>展开</summary>\n\n没有收尾。\n";
	expect(pair(source).size).toBe(0);
});
it("pairs nested disclosures without stealing the outer closer", () => {
	const source = "<details>\n<summary>A</summary>\n\n<details>\n<summary>B</summary>\n\n内层。\n</details>\n\n外层。\n</details>\n\n尾。\n";
	const spans = [...pair(source).values()];
	expect(spans).toHaveLength(1);
	expect(source.slice(spans[0].start, spans[0].end).endsWith("</details>")).toBe(true);
	expect(source.slice(spans[0].start, spans[0].end)).toContain("外层。");
});
it("ignores the editor's own controlled format so it keeps its attribute", () => {
	const source = '<details data-rich-collapse>\n<summary>A</summary>\n\n正文。\n</details>\n\n尾。\n';
	expect(pair(source).size).toBe(0);
});
