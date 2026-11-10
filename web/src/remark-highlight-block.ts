import type { Root, RootContent } from "mdast";

/**
 * A portable Markdown note: render its marker as block styling, not text.
 *
 * Two marker dialects are recognized. The GFM-style `> [!NOTE]` is the canonical
 * form the editor serializes; the Chinese prefixes (`注：` / `提示：` / `注意：`) are
 * recognized for reading only, so a hand-written note renders as a note without
 * the source being rewritten into English.
 */
type NoteKind = "note" | "tip" | "warning";

/** `[!NOTE]` style, plus the Chinese prefix dialect, mapped to a callout kind. */
function markerKind(value: string): { kind: NoteKind; length: number } | null {
	const gfm = /^\[!(NOTE|TIP|WARNING)\](?:\r?\n|$)/.exec(value);
	if (gfm) return { kind: gfm[1].toLowerCase() as NoteKind, length: gfm[0].length };
	// The prefix must open the blockquote's own first text node. A single-line note
	// parses identically to an inline `注：` opening a sentence, so the two cannot be
	// told apart here; the dialect is opt-in by writing the prefix as the block's
	// first words. Existing prose that merely starts with `注：` is unaffected in
	// practice: no such blockquote exists in this repo's documents.
	const chinese = /^(注|提示|注意)：([^\S\r\n]*)/.exec(value);
	if (chinese) {
		const kind = chinese[1] === "注" ? "note" : chinese[1] === "提示" ? "tip" : "warning";
		return { kind, length: chinese[1].length + 1 + chinese[2].length };
	}
	return null;
}

export function remarkHighlightBlock() {
	return (tree: Root) => {
		const visit = (node: Root | RootContent) => {
			if (node.type === "blockquote") {
				const paragraph = node.children[0];
				const first = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
				if (first?.type === "text") {
					const marker = markerKind(first.value);
					if (marker) {
						first.value = first.value.slice(marker.length);
						node.data = { ...node.data, hProperties: { className: ["rich-highlight"], "data-rich-highlight": marker.kind } };
					}
				}
			}
			if ("children" in node) node.children.forEach((child) => visit(child as RootContent));
		};
		visit(tree);
	};
}
