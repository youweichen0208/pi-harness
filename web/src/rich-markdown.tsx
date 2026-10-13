import { remarkTextHighlight, textHighlightColor } from "./remark-text-highlight";
import { richCodeText } from "./rich-code-text";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkHighlightBlock } from "./remark-highlight-block";
import rehypeHighlight from "rehype-highlight";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { Root, RootContent } from "mdast";
import { renderWikiLinks, wikiMetadata } from "./wiki-document";

import { wikiProperties } from "./wiki-properties";
import { findToc, TOC_END, TOC_START, tocItems, updateToc } from "./markdown-toc";

interface SourceBlock {
	raw: string;
	prefix: string;
	html: string;
	protected: boolean;
	hidden?: boolean;
	/** Generated table of contents; its list is rebuilt from headings, never edited. */
	toc?: boolean;
}
export interface RichLabels { source: string; toc: string; tocEmpty: string; tocRemove: string }
export interface RichDocument {
	source: string;
	blocks: SourceBlock[];
	suffix: string;
}
const parser = unified().use(remarkParse).use(remarkGfm);
function codeFenceMarkdown(node: HTMLElement): string {
	const code = node.querySelector("code");
	const text = richCodeText(code ?? node);
	const detected = code?.className.match(/language-([^\s]+)/)?.[1] ?? "";
	const lang = detected === "plaintext" ? "" : detected;
	const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)));
	return `\n\n${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}\n\n`;
}
const converter = new TurndownService({
	headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-",
	blankReplacement: (_content, node) => {
		if (node.nodeName === "BLOCKQUOTE" && node.hasAttribute("data-rich-highlight")) return "\n\n> [!NOTE]\n> \n\n";
		if (node.nodeName === "PRE") return codeFenceMarkdown(node);
		const fences = Array.from(node.querySelectorAll("pre"));
		if (fences.length) return fences.map(codeFenceMarkdown).join("\n\n");
		return "isBlock" in node && node.isBlock ? "\n\n" : "";
	},
});
converter.use(gfm);
converter.addRule("textHighlight", {
	filter: (node) => node.nodeName === "SPAN" && !!textHighlightColor((node as HTMLElement).style.backgroundColor),
	replacement: (content, node) => {
		const color = textHighlightColor((node as HTMLElement).style.backgroundColor)!;
		return `<mark style="background-color: ${color.hex}">${content}</mark>`;
	},
});
converter.addRule("highlightBlock", {
	filter: (node) => node.nodeName === "BLOCKQUOTE" && node.hasAttribute("data-rich-highlight"),
	replacement: (content) => "\n\n> [!NOTE]\n" + content.trim().split("\n").map((line) => "> " + line).join("\n") + "\n\n",
});
converter.addRule("taskCheckbox", {
	filter: (node) => node.nodeName === "INPUT" && node.getAttribute("type") === "checkbox",
	replacement: (_content, node) => (node as HTMLInputElement).checked ? "[x] " : "[ ] ",
});
converter.addRule("preservedSource", {
	filter: (node) => node.hasAttribute("data-rich-source"),
	replacement: (_content, node) => "\n\n" + node.getAttribute("data-rich-source") + "\n\n",
});
converter.addRule("preservedInlineSource", {
	filter: (node) => node.hasAttribute("data-rich-inline"),
	replacement: (_content, node) => node.getAttribute("data-rich-inline") ?? "",
});
converter.addRule("wikiLink", {
	filter: (node) => node.nodeName === "A" && (node.getAttribute("href") ?? "").startsWith("#wiki="),
	replacement: (content, node) => {
		let target: string;
		try { target = decodeURIComponent(node.getAttribute("href")!.slice(6)); } catch { return content; }
		return `[[${target}${content === target ? "" : "|" + content}]]`;
	},
});
converter.addRule("codeFence", {
	filter: "pre",
	replacement: (_content, node) => {
		return codeFenceMarkdown(node as HTMLElement);
	},
});
converter.addRule("tableBreak", {
	filter: "br",
	replacement: (_content, node) => node.closest("td, th") ? "<br>" : "  \n",
});
// Escape pipes within table cells rather than accidentally adding columns.
converter.addRule("tableCell", {
	filter: ["th", "td"],
	replacement: (content, node) => {
		const index = Array.from(node.parentNode?.childNodes ?? []).indexOf(node);
		return (index === 0 ? "| " : " ") + content.trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>") + " |";
	},
});

function needsSource(node: RootContent, nested = false): boolean {
	if (node.type === "html") return !nested;
	if (["definition", "footnoteDefinition", "footnoteReference"].includes(node.type)) return true;
	return "children" in node && node.children.some((child) => needsSource(child as RootContent, true));
}

/** Keep inline HTML literal and inert without downgrading its containing table/list. */
function preserveInlineHtml() {
	return (tree: Root) => {
		const visit = (node: Root | RootContent) => {
			if (!("children" in node)) return;
			for (let i = 0; i < node.children.length; i++) {
				const child = node.children[i];
				if (child.type === "html" && node.type !== "root") {
					if (/^<br\s*\/?>(?:\r?\n)?$/i.test(child.value)) {
						node.children[i] = { type: "break" };
					} else {
						node.children[i] = {
							type: "text", value: child.value,
							data: { hName: "span", hProperties: { "data-rich-inline": child.value, contentEditable: "false" },
								hChildren: [{ type: "text", value: child.value }] },
						};
					}
				} else visit(child as RootContent);
			}
		};
		visit(tree);
	};
}

/** Preserve source slices, including definitions/HTML/front matter, independently of editable DOM. */
export function prepareRichDocument(source: string, wiki = false): RichDocument {
	const blocks: SourceBlock[] = [];
	const nodes = parser.parse(source).children;
	const definitions = nodes.filter((node) => node.type === "definition").map((node) => source.slice(node.position?.start.offset, node.position?.end.offset)).join("\n");
	const frontMatter = source.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/)?.[0];
	const metadata = wiki ? wikiMetadata(source) : null;
	const properties = wiki ? wikiProperties(source).ranges : [];
	let firstHeading = true;
	let end = 0;
	const toc = findToc(source);
	if (frontMatter) {
		blocks.push({ raw: frontMatter.trimEnd(), prefix: "", html: "", protected: true, hidden: wiki });
		end = frontMatter.trimEnd().length;
	}
	for (const node of nodes) {
		const start = node.position?.start.offset;
		const stop = node.position?.end.offset;
		if (start === undefined || stop === undefined || start < end) continue;
		if (toc && start === toc.start) {
			blocks.push({ raw: source.slice(toc.start, toc.end), prefix: source.slice(end, start), html: "", protected: true, toc: true });
			end = toc.end;
			continue;
		}
		const raw = source.slice(start, stop);
		const protectedBlock = needsSource(node);
		const hidden = properties.some(range => range.start === start && range.end === stop) || (!!metadata && firstHeading && node.type === "heading" && node.depth === 1 && metadata.readingBody !== metadata.body);
		if (node.type === "heading" && node.depth === 1) firstHeading = false;
		blocks.push({
			raw, prefix: source.slice(end, start), protected: protectedBlock, hidden,
			html: protectedBlock ? "" : renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, remarkTextHighlight, preserveInlineHtml, remarkHighlightBlock]} rehypePlugins={wiki ? [] : [rehypeHighlight]}>{(wiki ? renderWikiLinks(raw) : raw) + "\n\n" + definitions}</ReactMarkdown>),
		});
		end = stop;
	}
	return { source, blocks, suffix: source.slice(end) };
}

/** Clickable, non-editable rendering of the generated list; editor-only controls are stripped on save. */
export function renderToc(wrapper: HTMLElement, source: string, labels: RichLabels): void {
	const doc = wrapper.ownerDocument;
	wrapper.contentEditable = "false";
	wrapper.dataset.richToc = "";
	wrapper.classList.add("rich-toc");
	const head = doc.createElement("div");
	head.className = "rich-toc-head";
	head.dataset.richUi = "";
	const title = doc.createElement("strong");
	title.textContent = labels.toc;
	const remove = doc.createElement("button");
	remove.type = "button";
	remove.dataset.richTocRemove = "";
	remove.textContent = labels.tocRemove;
	head.append(title, remove);
	const items = tocItems(source);
	const list = doc.createElement("ul");
	const top = Math.min(...items.map(item => item.depth));
	items.forEach((item, index) => {
		const entry = doc.createElement("li");
		entry.style.setProperty("--toc-level", String(item.depth - top));
		const link = doc.createElement("a");
		link.href = `#${item.slug}`;
		link.dataset.richTocIndex = String(index);
		link.textContent = item.text;
		entry.append(link);
		list.append(entry);
	});
	if (!items.length) {
		const empty = doc.createElement("p");
		empty.textContent = labels.tocEmpty;
		wrapper.replaceChildren(head, empty);
	} else wrapper.replaceChildren(head, list);
}

/** Initialize only on open or an external source replacement, never on a keystroke. */
export function mountRichDocument(root: HTMLElement, document: RichDocument, labels: RichLabels): void {
	const sourceLabel = labels.source;
	root.replaceChildren();
	let sourceLine = 1;
	document.blocks.forEach((block, index) => {
		sourceLine += block.prefix.split("\n").length - 1;
		const startLine = sourceLine;
		const wrapper = root.ownerDocument.createElement("div");
		wrapper.dataset.richBlock = String(index);
		wrapper.dataset.sourceStart = String(startLine);
		wrapper.dataset.sourceEnd = String(startLine + block.raw.split("\n").length - 1);
		wrapper.className = "rich-block";
		wrapper.hidden = !!block.hidden;
		if (block.toc) {
			wrapper.dataset.richSource = block.raw;
			renderToc(wrapper, document.source, labels);
		} else if (block.protected) {
			wrapper.contentEditable = "false";
			wrapper.dataset.richSource = block.raw;
			wrapper.classList.add("rich-source-block");
			const label = root.ownerDocument.createElement("small");
			label.textContent = sourceLabel;
			const code = root.ownerDocument.createElement("pre");
			code.textContent = block.raw;
			wrapper.append(label, code);
		} else {
			// HTML is produced by ReactMarkdown with its default URL/HTML safety policy.
			wrapper.innerHTML = block.html;
		}
		wrapper.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => { input.disabled = false; });
		root.append(wrapper);
		sourceLine += block.raw.split("\n").length - 1;
		block.html = wrapper.innerHTML;
	});
	if (!document.blocks.length) root.innerHTML = "<p><br></p>";
}

function serializeElement(node: Node, root: HTMLElement): string {
	const holder = root.ownerDocument.createElement("div");
	holder.append(node.cloneNode(true));
	// ReactMarkdown emits CSS alignment; Turndown's GFM rules read HTML align.
	holder.querySelectorAll<HTMLElement>("th, td").forEach((cell) => {
		const alignment = cell.style.textAlign;
		if (["left", "center", "right"].includes(alignment)) cell.setAttribute("align", alignment);
	});
	return converter.turndown(holder);
}

/** Untouched blocks round-trip byte-for-byte. Only edited blocks go through HTML → Markdown. */
export function readRichDocument(root: HTMLElement, document: RichDocument): string {
	// Editor-only controls must never affect source preservation or saved Markdown.
	root = root.cloneNode(true) as HTMLElement;
	root.querySelectorAll("[data-wiki-placeholder]").forEach(node => node.removeAttribute("data-wiki-placeholder"));
	root.querySelectorAll("[data-rich-ui]").forEach((node) => node.remove());
	root.querySelectorAll<HTMLImageElement>("img[data-rich-image-src]").forEach((img) => {
		img.setAttribute("src", img.dataset.richImageSrc!);
		img.removeAttribute("data-rich-image-src");
	});
	// Hidden metadata/title are outside the editable reading surface. A select-all
	// replacement must not delete them along with the visible body.
	for (let index = document.blocks.length - 1; index >= 0; index--) {
		const block = document.blocks[index];
		if (!block.hidden || root.querySelector(`[data-rich-block="${index}"]`)) continue;
		const restored = root.ownerDocument.createElement("div");
		restored.dataset.richBlock = String(index); restored.innerHTML = block.html;
		const next = [...root.children].find(child => Number((child as HTMLElement).dataset.richBlock) > index);
		if (next) root.insertBefore(restored, next); else root.prepend(restored);
	}
	const seen = new Set<number>();
	const parts: string[] = [];
	for (const child of Array.from(root.childNodes)) {
		const id = child instanceof HTMLElement ? child.dataset.richBlock : undefined;
		const index = id === undefined ? -1 : Number(id);
		const block = document.blocks[index];
		if (block && !seen.has(index)) {
			seen.add(index);
			const unchanged = child instanceof HTMLElement && child.tagName === "DIV" && child.innerHTML === block.html;
			const text = unchanged || block.protected ? block.raw : serializeElement(child, root);
			parts.push((parts.length ? block.prefix || "\n\n" : block.prefix) + text);
		} else if (child instanceof HTMLElement && child.hasAttribute("data-rich-toc")) {
			// Newly inserted block: markers only, the list is generated below.
			parts.push((parts.length ? "\n\n" : "") + `${TOC_START}\n${TOC_END}`);
		} else {
			const text = serializeElement(child, root);
			if (text) parts.push((parts.length ? "\n\n" : "") + text);
		}
	}
	return updateToc(parts.join("") + (parts.length ? document.suffix : ""));
}
