/**
 * Markdown parsers emit a hand-written `<details>` disclosure as several sibling
 * nodes: the opener, the body, then the closer. Splitting the rich document per
 * node therefore cuts one construct into pieces and leaves a stray `</details>`
 * block on its own. This module pairs those slices back into one source range.
 *
 * Deliberately DOM-free and Markdown-AST-free: it runs in node so the pairing
 * contract stays unit-testable. Only `details` is paired; a multi-line `figure`
 * or `div[data-rich-format]` is a known gap.
 */

export interface SeriesNode {
	type: string;
	start: number;
	end: number;
	value?: string;
}

export interface DisclosureSpan {
	start: number;
	end: number;
	/** The opener carried no attributes at all, so saving must not add them back. */
	bare: boolean;
}

const OPENER = /^\s*<details(?:\s[^>]*)?>/i;
const CLOSER = /^\s*<\/details\s*>/i;
const FENCE = /^\s*(?:`{3,}|~{3,})/;

/** An `<details>` opener that is not already the editor's own controlled format. */
function isBareOpener(raw: string): boolean {
	return OPENER.test(raw) && !/^<details\b[^>]*data-rich-collapse/i.test(raw.trimStart());
}

function depthDelta(raw: string): number {
	const opens = (raw.match(/<details\b/gi) ?? []).length;
	const closes = (raw.match(/<\/details\s*>/gi) ?? []).length;
	return opens - closes;
}

/**
 * Group top-level nodes into disclosure spans. Unbalanced input degrades locally:
 * an unmatched closer or an opener that never closes stays in its own node, which
 * is exactly the per-node behaviour that existed before.
 */
export function disclosureSpans(source: string, nodes: SeriesNode[]): Map<number, DisclosureSpan> {
	const spans = new Map<number, DisclosureSpan>();
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if (!node.value || !isBareOpener(node.value)) continue;
		// Only a whole-tag html slice may open a group; inline html lives inside a
		// paragraph and is handled by the inline preservation plugin.
		if (node.type !== "html") continue;
		if (depthDelta(node.value) <= 0) continue;
		let depth = depthDelta(node.value);
		let last = -1;
		for (let j = i + 1; j < nodes.length && depth > 0; j++) {
			const candidate = nodes[j];
			if (candidate.type === "html") {
				depth += depthDelta(candidate.value ?? "");
				if (depth <= 0) { last = j; break; }
				continue;
			}
			// A fenced code block could contain a literal `</details>` text line; the
			// parser already keeps it inside one node, so only html nodes count.
		}
		if (last < 0) continue;
		const closer = nodes[last].value ?? "";
		if (!CLOSER.test(closer)) continue;
		spans.set(i, { start: node.start, end: nodes[last].end, bare: true });
		i = last;
	}
	return spans;
}

/** Reject spans that would swallow a fenced code block, so prose stays editable. */
export function spansAreSafe(source: string, nodes: SeriesNode[], spans: Map<number, DisclosureSpan>): Map<number, DisclosureSpan> {
	const fenced = new Set<number>();
	for (let i = 0; i < nodes.length; i++) if (nodes[i].type === "code" && FENCE.test(source.slice(nodes[i].start, nodes[i].end))) fenced.add(i);
	if (!fenced.size) return spans;
	const kept = new Map<number, DisclosureSpan>();
	for (const [index, span] of spans) {
		let safe = true;
		for (const index2 of fenced) {
			const node = nodes[index2];
			if (node.start > span.start && node.end < span.end) { safe = false; break; }
		}
		if (safe) kept.set(index, span);
	}
	return kept;
}
