import { expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { remarkHighlightBlock } from "../../web/src/remark-highlight-block.js";

/** Parse, run the plugin, and read back each blockquote's callout kind + remaining text. */
const render = (source: string) => {
	const tree = unified().use(remarkParse).parse(source);
	remarkHighlightBlock()(tree as any);
	return tree.children.filter((node: any) => node.type === "blockquote").map((node: any) => ({
		kind: node.data?.hProperties?.["data-rich-highlight"] ?? null,
		text: node.children[0]?.children?.[0]?.value ?? "",
	}));
};

it("recognizes the canonical GFM marker", () => {
	expect(render("> [!NOTE]\n> 正文")[0]).toEqual({ kind: "note", text: "正文" });
});

it("recognizes note, tip and warning", () => {
	expect(render("> [!TIP]\n> a")[0].kind).toBe("tip");
	expect(render("> [!WARNING]\n> a")[0].kind).toBe("warning");
});

it("recognizes the Chinese prefix dialect without rewriting it into English", () => {
	expect(render("> 注：这是提醒")).toEqual([{ kind: "note", text: "这是提醒" }]);
	expect(render("> 提示：这是提示")[0].kind).toBe("tip");
	expect(render("> 注意：这是警告")[0].kind).toBe("warning");
});

it("keeps the body after the prefix when the note spans several paragraphs", () => {
	const [note] = render("> 注：第一段\n>\n> 第二段");
	expect(note.kind).toBe("note");
	expect(note.text).toBe("第一段");
});

it("leaves unrelated blockquotes untouched", () => {
	expect(render("> 普通引用").concat(render("> attention: 这不是标记"))).toEqual([
		{ kind: null, text: "普通引用" },
		{ kind: null, text: "attention: 这不是标记" },
	]);
});
