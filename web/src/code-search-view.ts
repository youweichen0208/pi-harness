import type { ContentSearchMatch } from "../../server/protocol.js";

export interface SearchToggles { caseSensitive: boolean; wholeWord: boolean; regex: boolean }

export interface MatchGroup { path: string; name: string; dir: string; matches: ContentSearchMatch[] }

/** Matches grouped by file in arrival order; lines sorted within a file. */
export function groupMatches(matches: readonly ContentSearchMatch[]): MatchGroup[] {
	const groups = new Map<string, MatchGroup>();
	for (const match of matches) {
		let group = groups.get(match.path);
		if (!group) {
			const parts = match.path.split("/");
			group = { path: match.path, name: parts.at(-1) ?? match.path, dir: parts.slice(0, -1).join("/"), matches: [] };
			groups.set(match.path, group);
		}
		group.matches.push(match);
	}
	for (const group of groups.values()) group.matches.sort((a, b) => a.line - b.line || a.column - b.column);
	return [...groups.values()];
}

/** Browser-side pattern for preview highlighting and regex validation; null means an invalid regex. */
export function highlightPattern(query: string, toggles: SearchToggles): RegExp | null {
	if (!query) return null;
	let source = toggles.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (toggles.wholeWord) source = `\\b(?:${source})\\b`;
	try { return new RegExp(source, toggles.caseSensitive ? "gu" : "giu"); } catch { return null; }
}

/** Preview spans 8 lines above the hit and 12 below, clamped to the file. */
export function previewWindow(totalLines: number, line: number): { start: number; end: number } {
	return { start: Math.max(1, line - 8), end: Math.min(totalLines, line + 12) };
}

/** Text split into plain and highlighted parts; overlapping or out-of-range ranges are merged and clamped. */
export function splitByRanges(text: string, ranges: readonly [number, number][]): { text: string; hit: boolean }[] {
	const sorted = ranges.map(([start, end]) => [Math.max(0, start), Math.min(text.length, end)] as [number, number]).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
	const parts: { text: string; hit: boolean }[] = [];
	let cursor = 0;
	for (const [start, end] of sorted) {
		if (end <= cursor) continue;
		const from = Math.max(start, cursor);
		if (from > cursor) parts.push({ text: text.slice(cursor, from), hit: false });
		const last = parts.at(-1);
		if (last?.hit && from === cursor) last.text += text.slice(from, end);
		else parts.push({ text: text.slice(from, end), hit: true });
		cursor = end;
	}
	if (cursor < text.length || !parts.length) parts.push({ text: text.slice(cursor), hit: false });
	return parts;
}
