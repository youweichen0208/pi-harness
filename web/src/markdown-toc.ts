import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, Nodes } from "mdast";

/** A maintained table of contents lives between these markers; nothing outside them is rewritten. */
export const TOC_START = "<!-- toc -->";
export const TOC_END = "<!-- /toc -->";
/** Headings deeper than this are left out of the generated list. */
const TOC_MAX_DEPTH = 3;

export interface TocItem { depth: number; text: string; slug: string }
export interface TocRange { start: number; end: number }

const parser = unified().use(remarkParse).use(remarkGfm);

/** Visible text of a heading, without link targets or emphasis markers. */
function plainText(node: Nodes): string {
	if ("value" in node && node.type !== "html") return node.value;
	return "children" in node ? node.children.map(child => plainText(child as Nodes)).join("") : "";
}

/** GitHub-compatible anchor (github-slugger): lowercase, drop punctuation, spaces to hyphens. */
export function headingSlug(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/** Top-level marker comments outside code; the first complete pair wins. */
function markerRange(tree: Root): TocRange | null {
	const nodes = tree.children;
	const start = nodes.findIndex(node => node.type === "html" && node.value.trim() === TOC_START);
	if (start < 0) return null;
	const end = nodes.findIndex((node, index) => index > start && node.type === "html" && node.value.trim() === TOC_END);
	if (end < 0) return null;
	const from = nodes[start].position?.start.offset, to = nodes[end].position?.end.offset;
	return from === undefined || to === undefined ? null : { start: from, end: to };
}

/** Source range of the marker-delimited block, including both markers. */
export function findToc(source: string): TocRange | null {
	return source.includes(TOC_START) ? markerRange(parser.parse(source)) : null;
}

/** Top-level H1–H3 after the block, with slugs numbered across the whole document like GitHub. */
export function tocItems(source: string, after = findToc(source)?.end ?? 0): TocItem[] {
	const seen = new Map<string, number>();
	const items: TocItem[] = [];
	for (const node of parser.parse(source).children) {
		if (node.type !== "heading") continue;
		const text = plainText(node).trim();
		const base = headingSlug(text);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		if (node.depth > TOC_MAX_DEPTH || !text || (node.position?.start.offset ?? 0) < after) continue;
		items.push({ depth: node.depth, text, slug: count ? `${base}-${count}` : base });
	}
	return items;
}

export function tocMarkdown(items: TocItem[]): string {
	const top = Math.min(...items.map(item => item.depth));
	const lines = items.map(item => `${"  ".repeat(item.depth - top)}- [${item.text.replace(/[[\]\\]/g, "\\$&")}](#${item.slug})`);
	return [TOC_START, ...lines, TOC_END].join("\n");
}

/** Regenerates only the marked block from the current headings; other bytes are untouched. */
export function updateToc(source: string): string {
	const range = findToc(source);
	if (!range) return source;
	const next = tocMarkdown(tocItems(source, range.end));
	return source.slice(0, range.start) + next + source.slice(range.end);
}
