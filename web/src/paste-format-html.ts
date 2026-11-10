/** Turn classified paste nodes into the editor's controlled HTML. DOM-free so it stays testable. */
import type { PasteNode } from "./paste-format.js";

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function assertNever(node: never): string {
	throw new Error(`unhandled paste node: ${JSON.stringify(node)}`);
}

/**
 * The same attribute contract `createMath` produces, built as a string so this module
 * needs no DOM. `paintMath` renders it on mount and the serializer reads
 * `data-rich-math-source` back, so the two paths stay interchangeable.
 */
function mathHtml(source: string, display: boolean): string {
	const escaped = escapeHtml(source);
	const raw = display ? `$$\n${source}\n$$` : `$${source}$`;
	return `<${display ? "div" : "span"} class="rich-math" contenteditable="false" data-rich-math="${escaped}" data-rich-math-display="${display}" data-rich-math-source="${escapeHtml(raw)}">${escaped}</${display ? "div" : "span"}>`;
}

function inlineHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\*([^*]+)\*/g, "<em>$1</em>");
}


/** A note is a colored callout; a folded note is the same callout inside one disclosure. */
function noteHtml(kind: "note" | "tip" | "warning", body: string, summary: string): string {
	const callout = `<blockquote class="rich-highlight" data-rich-highlight="${kind}">${body}</blockquote>`;
	if (!summary) return callout;
	return `<div data-rich-collapse=""><p data-rich-summary>${escapeHtml(summary)}</p><div data-rich-collapse-body>${callout}</div></div>`;
}

/**
 * Render a paste as one HTML string, inserted in a single `insertHTML` call. A folded
 * note must arrive in one piece: splitting it would let the Markdown serializer see a
 * stray `</details>`, which is what `rich-disclosure` exists to prevent.
 *
 * `fold` is only used for a lone `note`, which is the one shape the "fold this" action
 * targets; every other node keeps the shape the classifier found.
 */
export function pasteHtml(nodes: PasteNode[], options: { fold?: boolean } = {}): string {
	const only = nodes.length === 1 ? nodes[0] : null;
	const summary = options.fold && only?.type === "note" ? only.marker.replace(/\[!|\]/g, "") : "";
	const blocks = nodes.map((node): string => {
		switch (node.type) {
			case "text": {
				const paragraphs = node.value.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
				return paragraphs.map(part => `<p>${inlineHtml(part).replace(/\n/g, "<br>")}</p>`).join("");
			}
			case "heading": return `<h${node.level}>${inlineHtml(node.value)}</h${node.level}>`;
			case "code": return `<pre><code class="language-${escapeHtml(node.language)}">${escapeHtml(node.value)}</code></pre>`;
			case "math": return mathHtml(node.value, node.display);
			case "table": {
				const cells = (row: string[], tag: string) => row.map((cell, index) => `<${tag}${node.align[index] ? ` style="text-align: ${node.align[index]}"` : ""}>${inlineHtml(cell)}</${tag}>`).join("");
				return `<table><thead><tr>${cells(node.head, "th")}</tr></thead><tbody>${node.rows.map(row => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table>`;
			}
			case "list": return `<${node.ordered ? "ol" : "ul"}>${node.items.map(item => `<li>${inlineHtml(item)}</li>`).join("")}</${node.ordered ? "ol" : "ul"}>`;
			case "quote": return `<blockquote>${node.value.split(/\n{2,}/).map(part => `<p>${inlineHtml(part).replace(/\n/g, "<br>")}</p>`).join("")}</blockquote>`;
			case "note": {
				const body = node.value.split(/\n{2,}/).map(part => `<p>${inlineHtml(part).replace(/\n/g, "<br>")}</p>`).join("") || "<p><br></p>";
				return noteHtml(node.kind, body, summary);
			}
			case "foldedNote": {
				const body = node.value.split(/\n{2,}/).map(part => `<p>${inlineHtml(part).replace(/\n/g, "<br>")}</p>`).join("") || "<p><br></p>";
				return noteHtml(node.kind, body, node.summary);
			}
			// Every PasteNode variant is handled above; this keeps the switch exhaustive
			// if the union grows, instead of silently producing `undefined` markup.
			default: return assertNever(node);
		}
	});
	return blocks.join("") + "<p><br></p>";
}
