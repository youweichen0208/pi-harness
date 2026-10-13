import { describe, expect, it } from "vitest";
import { findToc, headingSlug, TOC_END, TOC_START, tocItems, updateToc } from "../../web/src/markdown-toc.js";

const doc = (toc: string) => `# Go 通道（Channel）完全教程\n\n${toc}\n\n## 1. 什么是 Channel?\n\n正文\n\n### 创建\n\n## 2. 无缓冲 Channel\n`;

describe("markdown table of contents", () => {
	it("uses GitHub-compatible anchors", () => {
		expect(headingSlug("1. 什么是 Channel?")).toBe("1-什么是-channel");
		expect(headingSlug("Hello, World!")).toBe("hello-world");
	});

	it("regenerates only the marked block from headings after it", () => {
		const source = doc(`${TOC_START}\n- [stale](#stale)\n${TOC_END}`);
		expect(updateToc(source)).toBe(doc([
			TOC_START,
			"- [1. 什么是 Channel?](#1-什么是-channel)",
			"  - [创建](#创建)",
			"- [2. 无缓冲 Channel](#2-无缓冲-channel)",
			TOC_END,
		].join("\n")));
	});

	it("is idempotent and leaves documents without markers byte-for-byte", () => {
		const once = updateToc(doc(`${TOC_START}\n${TOC_END}`));
		expect(updateToc(once)).toBe(once);
		const plain = "# A\n\n## B\r\n\ntext <!-- toc -->\n";
		expect(updateToc(plain)).toBe(plain);
	});

	it("ignores markers inside code and unterminated blocks", () => {
		const fenced = "```md\n<!-- toc -->\n<!-- /toc -->\n```\n\n## A\n";
		expect(findToc(fenced)).toBeNull();
		expect(updateToc(fenced)).toBe(fenced);
		const open = `${TOC_START}\n\n## A\n`;
		expect(updateToc(open)).toBe(open);
	});

	it("numbers duplicate slugs across the whole document and escapes link text", () => {
		const source = `## Setup\n\n${TOC_START}\n${TOC_END}\n\n## Setup\n\n## [x] \\[draft\\]\n\n#### Too deep\n`;
		expect(tocItems(source)).toEqual([
			{ depth: 2, text: "Setup", slug: "setup-1" },
			{ depth: 2, text: "[x] [draft]", slug: "x-draft" },
		]);
		expect(updateToc(source)).toContain("- [\\[x\\] \\[draft\\]](#x-draft)");
	});

	it("keeps an empty block when there are no headings yet", () => {
		expect(updateToc(`# Title\n\n${TOC_START}\n- [old](#old)\n${TOC_END}\n`)).toBe(`# Title\n\n${TOC_START}\n${TOC_END}\n`);
	});
});
