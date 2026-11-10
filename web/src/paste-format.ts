/**
 * Decide what a pasted text is made of, without touching the DOM.
 *
 * The editor's contract is "controlled HTML is a small document format, never a
 * general HTML renderer", so this module deliberately does not read `text/html`
 * from the clipboard. It converts only formats the source text carries explicitly:
 * standard Markdown block syntax, and LaTeX wrapped in an explicit delimiter.
 *
 * Nothing here guesses. Bare `x^2` stays literal text, because a guess that
 * silently turns a sentence into a KaTeX error is worse than leaving the source
 * alone. Anything unrecognized is reported as `text`, so the caller can insert it
 * verbatim.
 */

/** A paste slice, in source order. Adjacent `text` slices are never emitted; merge them. */
export type PasteNode =
	| { type: "text"; value: string }
	| { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; value: string }
	| { type: "code"; language: string; value: string }
	| { type: "math"; display: boolean; value: string }
	| { type: "table"; head: string[]; rows: string[][]; align: (string | null)[] }
	| { type: "list"; ordered: boolean; items: string[] }
	| { type: "quote"; value: string }
	| { type: "note"; kind: "note" | "tip" | "warning"; marker: string; value: string }
	| { type: "foldedNote"; kind: "note" | "tip" | "warning"; summary: string; value: string };

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const DISPLAY_MATH = /^\$\$(?:([\s\S]*?)\$\$|([\s\S]*))$/;
const BRACKET_MATH = /^\\\[(?:([\s\S]*?)\\\]|([\s\S]*))$/;
const NOTE_MARKER = /^\s*\[!(NOTE|TIP|WARNING)\]\s*$/i;
const CJK_NOTE_MARKER = /^\s*(注|提示|注意)：(.*)$/u;

const NOTE_KINDS: Record<string, "note" | "tip" | "warning"> = {
	note: "note", tip: "tip", warning: "warning",
};

function splitRow(line: string): string[] {
	return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(cell => cell.trim());
}

/** `:--`, `--:`, `:-:` decide alignment; a plain `---` means no alignment was stated. */
function readAlignment(line: string): (string | null)[] {
	return splitRow(line).map(cell => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		return left && right ? "center" : left ? "left" : right ? "right" : null;
	});
}

function isTableStart(lines: string[], index: number): boolean {
	return lines[index].includes("|") && !RULE.test(lines[index])
		&& index + 1 < lines.length && TABLE_DELIMITER.test(lines[index + 1])
		&& lines[index + 1].includes("-");
}

/**
 * TeX is only recognized when its delimiter is explicit and the content is non-empty.
 * An unterminated opener is not a formula: it is text the user is still typing.
 */
function readMath(text: string): { display: boolean; value: string } | null {
	const display = DISPLAY_MATH.exec(text);
	if (display) {
		const value = display[1] ?? display[2];
		if (value?.trim()) return { display: true, value: value.trim() };
	}
	const bracket = BRACKET_MATH.exec(text);
	if (bracket) {
		const value = bracket[1] ?? bracket[2];
		if (value?.trim()) return { display: true, value: value.trim() };
	}
	return null;
}

/** A `> [!NOTE]` blockquote, or the Chinese prefix dialect, becomes a note. */
function readNote(start: string[]): { kind: "note" | "tip" | "warning"; marker: string; value: string } | null {
	const gfm = NOTE_MARKER.exec(start[0]);
	if (gfm) {
		const kind = NOTE_KINDS[gfm[1].toLowerCase()];
		const body = start.slice(1);
		if (!kind) return null;
		return { kind, marker: `[!${gfm[1].toUpperCase()}]`, value: body.join("\n").trim() };
	}
	const cjk = CJK_NOTE_MARKER.exec(start[0]);
	if (cjk) {
		const kind = cjk[1] === "注" ? "note" : cjk[1] === "提示" ? "tip" : "warning";
		const body = [cjk[2], ...start.slice(1)].join("\n").trim();
		return { kind, marker: `[!${kind.toUpperCase()}]`, value: body };
	}
	return null;
}

/**
 * Classify pasted text into source-ordered nodes. Never throws, never loses input:
 * every character of `text` lands in exactly one node, either recognized or `text`.
 */
export function classifyPaste(text: string): PasteNode[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const nodes: PasteNode[] = [];
	let pending: string[] = [];
	const flush = () => {
		const value = pending.join("\n");
		if (value) nodes.push({ type: "text", value });
		pending = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// A fenced block is opaque: its content is never re-parsed, so `#` or `$$`
		// inside code stays literal.
		const fence = FENCE.exec(line);
		if (fence) {
			const marker = fence[2];
			const body: string[] = [];
			let closed = false;
			let j = i + 1;
			for (; j < lines.length; j++) {
				if (new RegExp(`^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[j])) { closed = true; break; }
				body.push(lines[j]);
			}
			if (closed) {
				flush();
				nodes.push({ type: "code", language: fence[3].toLowerCase() || "plaintext", value: body.join("\n") });
				i = j;
				continue;
			}
			// An unterminated fence is what it is for now: literal text, typing in progress.
		}

		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			nodes.push({ type: "heading", level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, value: heading[2].trim() });
			continue;
		}

		if (isTableStart(lines, i)) {
			flush();
			const align = readAlignment(lines[i + 1]);
			const head = splitRow(line);
			const rows: string[][] = [];
			let j = i + 2;
			for (; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) rows.push(splitRow(lines[j]));
			nodes.push({ type: "table", head, rows, align });
			i = j - 1;
			continue;
		}

		if (line.trimStart().startsWith(">")) {
			const quoted: string[] = [];
			let j = i;
			for (; j < lines.length && lines[j].trimStart().startsWith(">"); j++) quoted.push(lines[j].trimStart().replace(/^>\s?/, ""));
			flush();
			const inner = quoted.join("\n");
			const math = readMath(inner.trim());
			if (math) { nodes.push({ type: "math", display: math.display, value: math.value }); i = j - 1; continue; }
			const note = readNote(quoted);
			if (note) { nodes.push({ type: "note", ...note }); i = j - 1; continue; }
			nodes.push({ type: "quote", value: inner });
			i = j - 1;
			continue;
		}

		if (RULE.test(line)) {
			flush();
			pending.push(line);
			continue;
		}

		const bullet = BULLET.exec(line);
		const ordered = ORDERED.exec(line);
		if (bullet || ordered) {
			flush();
			const isOrdered = !!ordered;
			const items: string[] = [];
			let j = i;
			for (; j < lines.length; j++) {
				const m = isOrdered ? ORDERED.exec(lines[j]) : BULLET.exec(lines[j]);
				if (!m) break;
				items.push(m[1].trim());
			}
			nodes.push({ type: "list", ordered: isOrdered, items });
			i = j - 1;
			continue;
		}

		// Display TeX occupying whole lines, e.g. `$$ … $$` on their own.
		const trimmed = line.trim();
		const opening = /^\$\$/.test(trimmed) || /^\\\[/.test(trimmed);
		if (opening) {
			const closer = /^\$\$/.test(trimmed) ? "$$" : "\\]";
			const collected: string[] = [];
			let j = i;
			let closed = false;
			for (; j < lines.length; j++) {
				const candidate = j === i ? trimmed : lines[j].trim();
				if (j > i && candidate.endsWith(closer)) {
					collected.push(candidate.slice(0, -closer.length));
					closed = true;
					break;
				}
				collected.push(j === i ? candidate.replace(/^\$\$|^\\\[/, "") : candidate);
			}
			const value = collected.join("\n").trim();
			if (closed && value) {
				flush();
				nodes.push({ type: "math", display: true, value });
				i = j;
				continue;
			}
		}

		pending.push(line);
	}
	flush();
	return nodes;
}

/** True when a paste is worth offering the explicit "fold this" action for. */
export function shouldOfferFold(nodes: PasteNode[], options: { lines?: number; chars?: number } = {}): boolean {
	const minLines = options.lines ?? 20;
	const minChars = options.chars ?? 1200;
	if (!nodes.some(node => node.type !== "math")) return false;
	if (nodes.length === 1 && nodes[0].type === "note") return false;
	const lines = nodes.reduce((total, node) => total + renderNode(node).split("\n").length, 0);
	const chars = nodes.reduce((total, node) => total + renderNode(node).length, 0);
	return lines >= minLines || chars >= minChars;
}

/** The Markdown source a node came from, so a caller can insert it verbatim. */
export function renderNode(node: PasteNode): string {
	switch (node.type) {
		case "text": return node.value;
		case "heading": return `${"#".repeat(node.level)} ${node.value}`;
		case "code": return `\`\`\`${node.language === "plaintext" ? "" : node.language}\n${node.value}\n\`\`\``;
		case "math": return node.display ? `$$\n${node.value}\n$$` : `$${node.value}$`;
		case "table": {
			const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
			const align = node.align.map(a => a === "left" ? ":---" : a === "right" ? "---:" : a === "center" ? ":---:" : "---");
			return [row(node.head), `| ${align.join(" | ")} |`, ...node.rows.map(row)].join("\n");
		}
		case "list": return node.items.map((item, index) => `${node.ordered ? `${index + 1}.` : "-"} ${item}`).join("\n");
		case "quote": return node.value.split("\n").map(line => `> ${line}`).join("\n");
		case "note": return `> ${node.marker}\n` + node.value.split("\n").map(line => `> ${line}`).join("\n");
		case "foldedNote": {
			const body = `> [!${node.kind.toUpperCase()}]\n` + node.value.split("\n").map(line => `> ${line}`).join("\n");
			return `<details data-rich-collapse=""><summary>${node.summary}</summary>\n\n${body}\n</details>`;
		}
	}
}
