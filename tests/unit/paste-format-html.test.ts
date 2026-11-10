import { expect, it } from "vitest";
import { classifyPaste } from "../../web/src/paste-format.js";
import { pasteHtml } from "../../web/src/paste-format-html.js";

const html = (text: string, options?: { fold?: boolean }) => pasteHtml(classifyPaste(text), options);

it("emits headings, tables, lists and fences as controlled HTML", () => {
	expect(html("## 标题")).toContain("<h2>标题</h2>");
	expect(html("| a | b |\n| :-- | --: |\n| 1 | 2 |")).toContain('<th style="text-align: left">a</th>');
	expect(html("- one\n- two")).toContain("<ul><li>one</li><li>two</li></ul>");
	expect(html("```js\ncode\n```")).toContain('<pre><code class="language-js">code</code></pre>');
});

it("escapes HTML so pasted markup can never become an element", () => {
	expect(html("<script>alert(1)</script>")).not.toContain("<script>");
	expect(html("<img src=x onerror=alert(1)>")).toContain("&lt;img");
});

it("renders a note as a colored callout without folding", () => {
	const markup = html("> [!TIP]\n> 小心");
	expect(markup).toContain('<blockquote class="rich-highlight" data-rich-highlight="tip">');
	expect(markup).not.toContain("data-rich-collapse");
});

it("renders a lone note folded when asked, as one disclosure", () => {
	const markup = html("> [!NOTE]\n> 正文", { fold: true });
	expect(markup).toContain('<div data-rich-collapse="">');
	expect(markup).toContain("<p data-rich-summary>NOTE</p>");
	expect(markup).toContain('<blockquote class="rich-highlight" data-rich-highlight="note">');
	// Exactly one disclosure: a second opener would split the fragment in two.
	expect(markup.split('<div data-rich-collapse="">').length - 1).toBe(1);
	expect(markup.split('data-rich-collapse-body').length - 1).toBe(1);
});

it("does not fold content that is not a single note", () => {
	expect(html("## 标题\n\n正文", { fold: true })).not.toContain("data-rich-collapse");
});

it("always ends with an editable trailing paragraph", () => {
	expect(html("## 标题").endsWith("<p><br></p>")).toBe(true);
});
