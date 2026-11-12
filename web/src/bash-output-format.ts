import { commandPresentation, hasSearchSourceNumbers, searchSourceNumberParts } from "./bash-presentation.js";
import { splitCommandChain } from "./bash-steps.js";
import { langFromPath } from "./hljs-lite.js";

type SearchRecord = { path: string; line: string; text: string; language: string | null; markdown: boolean };
export type OutputFormat = { kind: "mixed"; log: string; records: SearchRecord[] } | { kind: "terminal" } | { kind: "search"; records: { path: string; line: string; text: string; language: string | null; markdown: boolean }[] } | { kind: "markdown"; text: string } | { kind: "code"; text: string; language: string };
const markdownPath = (path: string) => /\.(md|markdown)$/i.test(path);

/** Presentation only. Ambiguous commands and incomplete/mixed output remain terminal text. */
export function formatBashOutput(command: string, output: string, settled: boolean): OutputFormat {
	if (!settled || !output.trim() || output.length > 100_000) return { kind: "terminal" };
	const source = commandPresentation(command, "/").command;
	const repeated = repeatedSearchOutput(source, output);
	if (repeated) return repeated;
	if (hasSearchSourceNumbers(command)) {
		const target = /\s+([^\s'"|]+\.[\w]+)\s*(?:\|\s*(?:head|tail)\b.*)?$/.exec(source)?.[1] ?? "";
		const lines = output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
		const records = lines.map(line => {
			const part = searchSourceNumberParts(line);
			if (!part) return null;
			const path = part.prefix ? part.prefix.slice(0, -1) : target;
			return { path, line: part.number.slice(0, -1), text: part.rest, language: langFromPath(path), markdown: markdownPath(path) };
		});
		if (records.every(record => record !== null)) return { kind: "search", records };
		return { kind: "terminal" };
	}
	const mixed = mixedSearchOutput(source, output);
	if (mixed) return mixed;
	// Validate JSON, then indent the original tokens so large integers retain precision.
	if (/^[\[{]/.test(output.trim())) {
		try {
			JSON.parse(output);
			let depth = 0;
			const tokens = output.match(/"(?:\\.|[^"\\])*"|[^\s]/g) ?? [];
			let text = "";
			for (let i = 0; i < tokens.length; i++) {
				const token = tokens[i];
				if (token === "{" || token === "[") { depth++; text += token + "\n" + "  ".repeat(depth); }
				else if (token === "}" || token === "]") { depth--; text += "\n" + "  ".repeat(depth) + token; }
				else if (token === ",") text += ",\n" + "  ".repeat(depth);
				else if (token === ":") text += ": ";
				else text += token;
			}
			return { kind: "code", language: "json", text };
		} catch { /* Partial JSON and logs retain their original layout. */ }
	}
	// Only a single literal file reader establishes the language of arbitrary text.
	const read = /^(?:cat|head(?:\s+-n\s+\d+|\s+-\d+)?|tail(?:\s+-n\s+\d+|\s+-\d+)?|sed\s+-n\s+'\d+(?:,\d+)?p')\s+(?:"([^"$`]+)"|'([^']+)'|([^\s;&|<>$`]+))\s*$/.exec(source);
	const path = read?.slice(1).find(Boolean);
	if (path && markdownPath(path)) return { kind: "markdown", text: output };
	if (path && langFromPath(path)) return { kind: "code", text: output, language: langFromPath(path)! };
	return { kind: "terminal" };
}

/** Only combine chains whose searches all name the same literal file. */
function repeatedSearchOutput(source: string, output: string): Extract<OutputFormat, { kind: "search" }> | null {
	if (/[\n`]|\$\(/.test(source)) return null;
	const parts = splitCommandChain(source);
	if (parts.length < 2) return null;
	let target = "";
	let searches = 0;
	let separator = false;
	for (const part of parts) {
		if (/^echo\s+(?:---|'---'|"---")$/.test(part.trim())) { separator = true; continue; }
		const path = /^(?:rg|grep)\s+(?:-n|--line-number)\s+(?:"[^"$`]*"|'[^']*'|[^\s;&|$`]+)\s+([^\s'";&|$`*?]+\.[\w]+)\s*$/.exec(part.trim())?.[1];
		if (!path || target && target !== path) return null;
		target = path;
		searches++;
	}
	if (searches < 2) return null;
	const records: SearchRecord[] = [];
	for (const line of output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")) {
		if (separator && line === "---") continue;
		const part = searchSourceNumberParts(line);
		if (!part || part.prefix && part.prefix !== target + ":") return null;
		records.push({ path: target, line: part.number.slice(0, -1), text: part.rest, language: langFromPath(target), markdown: markdownPath(target) });
	}
	return records.length ? { kind: "search", records } : null;
}

/** Read only the shell suffix after an explicitly closed Python heredoc, never its body. */
function mixedSearchOutput(source: string, output: string): Extract<OutputFormat, { kind: "mixed" }> | null {
	let search: string;
	const heredoc = /^python(?:3)?\s+-\s*<<\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\n/.exec(source);
	if (heredoc) {
		const body = source.slice(heredoc[0].length).split("\n");
		const end = body.findIndex(line => line === heredoc[2]);
		if (end < 0) return null;
		search = body.slice(end + 1).join("\n").trim();
	} else {
		if (/[\n`]|\$\(/.test(source)) return null;
		const parts = splitCommandChain(source);
		if (parts.length < 2) return null;
		search = parts.at(-1)!;
	}
	if (!hasSearchSourceNumbers(search)) return null;
	// A single literal target prevents assigning bare line numbers to the wrong file.
	const target = /^(?:rg|grep)\s+(?:-n|--line-number)\s+(?:"[^"$`]*"|'[^']*'|[^\s;&|$`]+)\s+([^\s'";&|$`*?]+\.[\w]+)\s*(?:\|\s*(?:head|tail)(?:\s+-\d+|\s+-n\s+\d+)?)?\s*$/.exec(search)?.[1];
	if (!target) return null;
	const lines = output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
	const records: SearchRecord[] = [];
	let index = lines.length - 1;
	for (; index >= 0; index--) {
		const part = searchSourceNumberParts(lines[index]);
		if (!part || part.prefix && part.prefix !== target + ":") break;
		records.unshift({ path: target, line: part.number.slice(0, -1), text: part.rest, language: langFromPath(target), markdown: markdownPath(target) });
	}
	if (!records.length || index < 0) return null;
	return { kind: "mixed", log: lines.slice(0, index + 1).join("\n"), records };
}

export const SEARCH_PREVIEW_LIMIT = 3;
export const TEXT_PREVIEW_LIMIT = 6;
export function formattedOutputCanExpand(format: OutputFormat): boolean {
	if (format.kind === "terminal") return false;
	if (format.kind === "search") return format.records.length > SEARCH_PREVIEW_LIMIT;
	if (format.kind === "mixed") return format.records.length > SEARCH_PREVIEW_LIMIT || format.log.split("\n").length > SEARCH_PREVIEW_LIMIT;
	return format.text.split("\n").length > TEXT_PREVIEW_LIMIT;
}

/** Omit leading blank space for display; preserve internal spacing and nested indentation. */
export function alignOutputCode(text: string): string {
	const lines = text.replace(/^(?:[ \t]*\r?\n)+/, "").split("\n");
	const content = lines.filter(line => line.trim());
	let indent = /^[ \t]*/.exec(content[0] ?? "")![0];
	for (const line of content) while (indent && !line.startsWith(indent)) indent = indent.slice(0, -1);
	return lines.map(line => line.startsWith(indent) ? line.slice(indent.length) : line).join("\n");
}
