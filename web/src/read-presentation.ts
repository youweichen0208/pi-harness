/** Parse a read tool's path without exposing its JSON arguments in the UI. */
export function readPath(argumentsText?: string): string | null {
	if (!argumentsText) return null;
	try {
		const value: unknown = JSON.parse(argumentsText);
		if (!value || typeof value !== "object" || !("path" in value)) return null;
		return typeof value.path === "string" ? value.path : null;
	} catch {
		return null;
	}
}

export function displayReadPath(path: string): string {
	const home = path.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/)?.[0];
	return home ? `~${path.slice(home.length)}` : path;
}

/** Read results end with a bracketed hint from the tool ("[Showing lines 12-40
 *  of 120. Use offset=41 to continue.]"). It is an annotation, not file text:
 *  it must not decide the common indent, and it stays unindented. */
const READ_TRAILER = /^\[(?:(?:Show(?:ing)? lines?)|(?:Line \d+ is)|(?:\d+ more lines? in (?:the )?file)|(?:Image: original))/;

/** Drop the indentation every previewed line shares. A deeply nested JSX read
 *  otherwise starts ~30 columns in and pushes long lines out of view; the
 *  relative nesting is what carries meaning, the common base does not. Reads
 *  that are already flush left, or that mix tabs and spaces, are unchanged. */
export function dedentReadPreview(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let shared: string | null = null;
	for (const line of lines) {
		if (!line.trim() || READ_TRAILER.test(line)) continue;
		const indent = /^[\t ]*/.exec(line)?.[0] ?? "";
		if (shared === null) {
			shared = indent;
		} else {
			let prefix = 0;
			while (prefix < shared.length && prefix < indent.length && shared[prefix] === indent[prefix]) prefix++;
			shared = shared.slice(0, prefix);
		}
		if (shared === "") return text;
	}
	if (!shared) return text;
	return lines.map((line) => (line.startsWith(shared) ? line.slice(shared.length) : line)).join("\n");
}

/** Keep YAML frontmatter out of Markdown rendering, where `---` can turn
 *  its first value into a giant setext heading. */
export function splitFrontmatter(text: string): { fields: { name: string; value: string }[]; body: string } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[0]?.trim() !== "---") return { fields: [], body: text };
	const end = lines.findIndex((line, index) => index > 0 && index < 50 && line.trim() === "---");
	if (end < 0) return { fields: [], body: text };
	const fields: { name: string; value: string }[] = [];
	for (const line of lines.slice(1, end)) {
		const match = /^([\w-]+):\s*(.*)$/.exec(line);
		if (match) fields.push({ name: match[1], value: match[2].replace(/^['"]|['"]$/g, "") });
		else if (/^\s+\S/.test(line) && fields.length) fields[fields.length - 1].value += ` ${line.trim()}`;
	}
	return { fields, body: lines.slice(end + 1).join("\n").trimStart() };
}
