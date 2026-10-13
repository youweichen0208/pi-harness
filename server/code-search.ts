import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { ContentSearchMatch, ServerMessage } from "./protocol.js";

/** Limits from the code-search guide: keep big repos and minified files from flooding the UI. */
export const CODE_SEARCH_LIMITS = { totalMatches: 500, perFile: 20, timeoutMs: 5000, lineChars: 300, maxFileSize: "1M", batchMs: 60 } as const;

export interface CodeSearchOptions {
	query: string;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	regex?: boolean;
	include?: string[];
}

/** ripgrep arguments; the query always follows `-e` so a leading dash is never read as a flag. */
export function ripgrepArgs(options: CodeSearchOptions): string[] {
	const args = ["--json", "--line-number", "--column", `--max-count=${CODE_SEARCH_LIMITS.perFile}`, `--max-filesize=${CODE_SEARCH_LIMITS.maxFileSize}`, "--glob=!.git"];
	args.push(options.caseSensitive ? "--case-sensitive" : "--ignore-case");
	if (options.wholeWord) args.push("--word-regexp");
	if (!options.regex) args.push("--fixed-strings");
	for (const glob of options.include ?? []) if (glob.trim()) args.push(`--glob=${glob.trim()}`);
	args.push("-e", options.query, "--", ".");
	return args;
}

/** UTF-8 byte offset → UTF-16 index, since ripgrep reports bytes and the browser slices strings. */
function charIndex(text: string, byteOffset: number): number {
	return Buffer.from(text, "utf8").subarray(0, byteOffset).toString("utf8").length;
}

/** One `--json` line → a match, or null for begin/end/summary records and non-UTF-8 lines. */
export function parseRipgrepLine(line: string): ContentSearchMatch | null {
	let record: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: { start: number; end: number }[] } };
	try { record = JSON.parse(line); } catch { return null; }
	if (record.type !== "match" || !record.data) return null;
	const path = record.data.path?.text;
	const raw = record.data.lines?.text;
	if (typeof path !== "string" || typeof raw !== "string" || typeof record.data.line_number !== "number") return null;
	const text = raw.replace(/\r?\n$/, "");
	let ranges = (record.data.submatches ?? []).map(({ start, end }) => [charIndex(text, start), charIndex(text, end)] as [number, number]).filter(([start, end]) => end > start);
	let shown = text;
	// Long lines (minified bundles, lock files) show a window around the first hit.
	if (text.length > CODE_SEARCH_LIMITS.lineChars) {
		const from = Math.max(0, Math.min((ranges[0]?.[0] ?? 0) - 40, text.length - CODE_SEARCH_LIMITS.lineChars));
		shown = text.slice(from, from + CODE_SEARCH_LIMITS.lineChars);
		ranges = ranges.map(([start, end]) => [start - from, Math.min(end - from, shown.length)] as [number, number]).filter(([start, end]) => start >= 0 && end > start);
	}
	return { path: path.replace(/\\/g, "/").replace(/^\.\//, ""), line: record.data.line_number, column: (ranges[0]?.[0] ?? 0) + 1, text: shown, ranges };
}

/** Bundled ripgrep first, then whatever `rg` is on PATH. */
export function ripgrepBinary(): string {
	try {
		const { rgPath } = createRequire(import.meta.url)("@vscode/ripgrep") as { rgPath: string };
		if (rgPath && existsSync(rgPath)) return rgPath;
	} catch { /* optional platform package missing: fall back to PATH */ }
	return process.platform === "win32" ? "rg.exe" : "rg";
}

/** One running search per client: a newer request kills the older process before it starts. */
export class CodeSearch {
	private child?: ChildProcess;
	private current = 0;
	constructor(private readonly emit: (message: ServerMessage) => void) {}

	cancel() {
		this.current = 0;
		this.child?.kill();
		this.child = undefined;
	}

	search(cwd: string, reqId: number, options: CodeSearchOptions) {
		this.cancel();
		this.current = reqId;
		const reply = (extra: Partial<Extract<ServerMessage, { type: "search_content_result" }>> & { matches: ContentSearchMatch[] }) =>
			this.emit({ type: "search_content_result", cwd, reqId, ok: true, done: false, ...extra });
		if (!options.query) { reply({ done: true, matches: [] }); return; }
		let child: ChildProcess;
		try {
			child = spawn(ripgrepBinary(), ripgrepArgs(options), { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch (error) {
			reply({ ok: false, done: true, error: (error as Error).message, matches: [] });
			return;
		}
		this.child = child;
		let pending: ContentSearchMatch[] = [];
		let total = 0;
		let truncated = false;
		let finished = false;
		let buffer = "";
		let stderr = "";
		const live = () => this.current === reqId && !finished;
		const flush = () => { if (pending.length && live()) { reply({ matches: pending }); pending = []; } };
		const batch = setInterval(flush, CODE_SEARCH_LIMITS.batchMs);
		const finish = (extra: { ok?: boolean; error?: string } = {}) => {
			if (finished) return;
			clearInterval(batch);
			clearTimeout(timer);
			if (this.current !== reqId) { finished = true; return; }
			const matches = pending;
			pending = [];
			finished = true;
			if (this.child === child) this.child = undefined;
			this.emit({ type: "search_content_result", cwd, reqId, ok: extra.ok ?? true, done: true, ...(truncated ? { truncated: true } : {}), ...(extra.error ? { error: extra.error } : {}), matches });
		};
		const timer = setTimeout(() => { truncated = true; child.kill(); finish(); }, CODE_SEARCH_LIMITS.timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			if (!live()) return;
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const match = parseRipgrepLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (match) {
					pending.push(match);
					if (++total >= CODE_SEARCH_LIMITS.totalMatches) { truncated = true; child.kill(); finish(); return; }
				}
				newline = buffer.indexOf("\n");
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
		child.on("error", (error) => finish({ ok: false, error: error.message }));
		// rg exits 1 when nothing matched and 2 on errors; with matches, 2 just means some files were unreadable.
		child.on("close", (code) => finish(code === 2 && !truncated && total === 0 ? { ok: false, error: stderr.trim().split("\n").at(-1) || "ripgrep failed" } : {}));
	}
}

/** File-name search through `rg --files`: honours .gitignore, includes dotfiles, skips .git.
 * Resolves null when ripgrep cannot start so the caller can fall back to its own walk. */
export function ripgrepFileNames(cwd: string, query: string, limit: number, timeoutMs: number, exclude: Iterable<string> = []): Promise<{ paths: string[]; dirs: string[]; truncated: boolean } | null> {
	const needle = query.toLowerCase();
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(ripgrepBinary(), ["--files", "--hidden", "--glob=!.git", ...[...exclude].map(name => `--glob=!${name}`)], { cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		} catch { resolve(null); return; }
		const paths: string[] = [];
		// Folders have no line of their own in `rg --files`; matching ones come from file paths.
		const dirs = new Set<string>();
		let buffer = "";
		let truncated = false;
		let settled = false;
		const done = (value: { paths: string[]; dirs: string[]; truncated: boolean } | null) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); resolve(value); };
		const timer = setTimeout(() => { truncated = true; done({ paths, dirs: [...dirs], truncated }); }, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const path = line.replace(/\r$/, "").replace(/\\/g, "/");
				if (!path) continue;
				const parts = path.split("/");
				for (let depth = 1; depth < parts.length; depth++) if (parts[depth - 1].toLowerCase().includes(needle)) dirs.add(parts.slice(0, depth).join("/"));
				if (!(parts.at(-1) ?? "").toLowerCase().includes(needle)) continue;
				paths.push(path);
				if (paths.length + dirs.size >= limit) { truncated = true; done({ paths, dirs: [...dirs], truncated }); return; }
			}
		});
		child.on("error", () => done(null));
		child.on("close", (code) => done(code === 0 || code === 1 || paths.length ? { paths, dirs: [...dirs], truncated } : null));
	});
}
