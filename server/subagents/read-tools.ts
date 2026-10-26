import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseRipgrepLine, ripgrepBinary } from "../code-search.js";
import { decodeText, looksLikeText } from "../text-sniff.js";

export const SOURCE_READ_LIMITS = {
	fileBytes: 1024 * 1024,
	outputBytes: 24 * 1024,
	readLines: 300,
	listEntries: 200,
	searchMatches: 100,
	searchBytes: 2 * 1024 * 1024,
	searchMs: 5000,
	pathChars: 2048,
	queryChars: 256,
} as const;

const excluded = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache", "target", ".venv", "__pycache__"]);
const pathSchema = Type.String({ minLength: 1, maxLength: SOURCE_READ_LIMITS.pathChars, description: "Path relative to this source's root; no absolute paths, parent traversal or symbolic links." });

export interface SourceObservation {
	evidenceId: string;
	path: string;
	sha256: string;
	line: number;
	text: string;
	complete: boolean;
}

export type SourceObserver = (observation: SourceObservation) => void;

function evidenceId(source: string, path: string, sha256: string): string {
	return `ev_${createHash("sha256").update(source).update("\0").update(path).update("\0").update(sha256).digest("hex").slice(0, 24)}`;
}

function integer(value: unknown, fallback: number, max: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}.`);
	return value;
}

function sourcePath(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > SOURCE_READ_LIMITS.pathChars || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid source-relative path.");
	if (isAbsolute(value) || win32.isAbsolute(value) || /^[a-z]:/i.test(value) || value.includes("\\")) throw new Error("Use a source-relative path with forward slashes.");
	const parts = value.split("/");
	if (parts.includes("..")) throw new Error("Parent traversal is outside the source boundary.");
	if (parts.some(part => excluded.has(part.toLowerCase()))) throw new Error("Dependency, generated and version-control directories are excluded.");
	return parts.filter(part => part && part !== ".").join("/") || ".";
}

function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Keep text plus the truncation notice within a hard byte budget, including multibyte source text. */
class Output {
	private lines: string[] = [];
	private bytes = 0;
	truncated = false;
	add(line: string): boolean {
		const cost = Buffer.byteLength(line) + 1;
		if (this.bytes + cost > SOURCE_READ_LIMITS.outputBytes - 200) { this.truncated = true; return false; }
		this.lines.push(line); this.bytes += cost;
		return true;
	}
	text(): string { return this.lines.join("\n") + (this.truncated ? "\n[Results truncated. Narrow the path/query or request a smaller line range.]" : ""); }
}

function snippet(line: string): string {
	return line.length > 1200 ? `${line.slice(0, 1200)} [line truncated]` : line;
}

/** Tools capture one canonical source. Child sessions never receive native filesystem or shell tools. */
export async function createSourceReadTools(root: string): Promise<ToolDefinition[]> {
	return (await createSourceReader(root)).tools;
}

/** The verifier shares the original root identity and never emits new observations. */
export async function createSourceReader(root: string, observe?: SourceObserver): Promise<{
	tools: ToolDefinition[];
	verify: (path: string, sha256: string, signal?: AbortSignal) => Promise<void>;
}> {
	const canonicalRoot = await realpath(root);
	const rootIdentity = await stat(canonicalRoot);
	if (!rootIdentity.isDirectory()) throw new Error("Source root must be a directory.");
	const sourceIdentity = `${canonicalRoot}\0${rootIdentity.dev}:${rootIdentity.ino}`;

	const checkedPath = async (input: unknown, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		const path = sourcePath(input);
		const currentRoot = await lstat(canonicalRoot);
		if (!currentRoot.isDirectory() || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino || await realpath(canonicalRoot) !== canonicalRoot) throw new Error("Source root changed; refresh the registered source.");
		let absolute = canonicalRoot;
		for (const part of path === "." ? [] : path.split("/")) {
			signal?.throwIfAborted();
			absolute = resolve(absolute, part);
			if ((await lstat(absolute)).isSymbolicLink()) throw new Error("Symbolic links are not available to source readers.");
		}
		const actual = await realpath(absolute);
		if (!isWithin(canonicalRoot, actual)) throw new Error("Path is outside the source boundary.");
		const actualRelative = relative(canonicalRoot, actual).split(sep).join("/") || ".";
		sourcePath(actualRelative);
		signal?.throwIfAborted();
		return { path: actualRelative, absolute: actual };
	};

	const readText = async (input: unknown, signal?: AbortSignal) => {
		const checked = await checkedPath(input, signal);
		const before = await lstat(checked.absolute);
		if (!before.isFile()) throw new Error("Source reads require a regular text file.");
		if (before.size > SOURCE_READ_LIMITS.fileBytes) throw new Error("Source file exceeds the 1 MiB reading limit.");
		// O_NOFOLLOW closes the final-component symlink race on platforms that support it.
		const file = await open(checked.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const opened = await file.stat();
			const verified = await checkedPath(checked.path, signal);
			const after = await lstat(verified.absolute);
			if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== after.dev || opened.ino !== after.ino) throw new Error("Source file changed while opening; retry the read.");
			if (opened.size > SOURCE_READ_LIMITS.fileBytes) throw new Error("Source file exceeds the 1 MiB reading limit.");
			const chunks: Buffer[] = [];
			let size = 0;
			while (true) {
				signal?.throwIfAborted();
				const chunk = Buffer.alloc(Math.min(65536, SOURCE_READ_LIMITS.fileBytes + 1 - size));
				const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
				if (!bytesRead) break;
				size += bytesRead;
				if (size > SOURCE_READ_LIMITS.fileBytes) throw new Error("Source file exceeds the 1 MiB reading limit.");
				chunks.push(chunk.subarray(0, bytesRead));
			}
			signal?.throwIfAborted();
			const bytes = Buffer.concat(chunks);
			if (!looksLikeText(bytes)) throw new Error("Source file is binary; only text/code/Markdown can be read.");
			const lines = decodeText(bytes).split("\n");
			if (!bytes.length || bytes.at(-1) === 10) lines.pop();
			return { path: checked.path, lines: lines.map(line => line.replace(/\r$/, "")), sha256: createHash("sha256").update(bytes).digest("hex") };
		} finally { await file.close(); }
	};

	const listParams = Type.Object({ path: Type.Optional(pathSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SOURCE_READ_LIMITS.listEntries })) });
	const list: ToolDefinition<typeof listParams> = {
		name: "source_list", label: "List source", description: "List immediate files/directories in this source (default path '.', at most 200 entries). Symbolic links, dependencies and generated directories are excluded.", parameters: listParams,
		execute: async (_id, params, signal) => {
			const limit = integer(params.limit, 100, SOURCE_READ_LIMITS.listEntries, "limit");
			const checked = await checkedPath(params.path ?? ".", signal);
			const output = new Output();
			const entries: string[] = [];
			const directory = await opendir(checked.absolute);
			for await (const entry of directory) {
				signal?.throwIfAborted();
				if (excluded.has(entry.name.toLowerCase()) || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || /[\x00-\x1f\x7f]/.test(entry.name)) continue;
				if (entries.length >= limit) { output.truncated = true; break; }
				entries.push(`${checked.path === "." ? "" : `${checked.path}/`}${entry.name}${entry.isDirectory() ? "/" : ""}`);
			}
			signal?.throwIfAborted();
			for (const entry of entries.sort()) if (!output.add(entry)) break;
			return { content: [{ type: "text", text: output.text() || "No visible entries." }], details: { path: checked.path, truncated: output.truncated } };
		},
	};
	const readParams = Type.Object({ path: pathSchema, startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SOURCE_READ_LIMITS.readLines })) });
	const read: ToolDefinition<typeof readParams> = {
		name: "source_read", label: "Read source", description: "Read a text/code/Markdown file in this source, up to 1 MiB. Returns source-relative paths, original 1-based line numbers and a SHA-256 fingerprint. Default 150 lines; at most 300 lines and 24 KiB output.", parameters: readParams,
		execute: async (_id, params, signal) => {
			const start = integer(params.startLine, 1, 1000000, "startLine");
			const limit = integer(params.limit, 150, SOURCE_READ_LIMITS.readLines, "limit");
			const file = await readText(params.path, signal);
			const output = new Output();
			const id = evidenceId(sourceIdentity, file.path, file.sha256);
			output.add(`${file.path} (${file.lines.length} lines; SHA-256 ${file.sha256}${observe ? `; evidenceId ${id}` : ""})`);
			if (start > file.lines.length) output.add(file.lines.length ? "Requested line is beyond the end of this file." : "Empty file.");
			const end = Math.min(file.lines.length, start - 1 + limit);
			for (let line = start; line <= end; line++) {
				if (file.lines[line - 1].length > 1200) output.truncated = true;
				if (!output.add(`${file.path}:${line}: ${snippet(file.lines[line - 1])}`)) break;
				observe?.({ evidenceId: id, path: file.path, sha256: file.sha256, line, text: file.lines[line - 1].slice(0, 1200), complete: file.lines[line - 1].length <= 1200 });
			}
			if (end < file.lines.length) output.truncated = true;
			return { content: [{ type: "text", text: output.text() }], details: { path: file.path, sha256: file.sha256, totalLines: file.lines.length, truncated: output.truncated, ...(observe ? { evidenceId: id } : {}) } };
		},
	};

	const searchParams = Type.Object({ query: Type.String({ minLength: 1, maxLength: SOURCE_READ_LIMITS.queryChars }), path: Type.Optional(pathSchema), caseSensitive: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SOURCE_READ_LIMITS.searchMatches })) });
	const search: ToolDefinition<typeof searchParams> = {
		name: "source_search", label: "Search source", description: "Search for a literal, single-line substring within this source. Defaults to case-sensitive, path '.', 50 matches. Respects ignore files, skips symbolic links/dependencies/generated directories and files over 1 MiB. Maximum 100 matches, 24 KiB output and 5 seconds; results carry relative paths and original line numbers.", parameters: searchParams,
		execute: async (_id, params, signal) => {
			if (typeof params.query !== "string" || !params.query || params.query.length > SOURCE_READ_LIMITS.queryChars || /[\x00\r\n]/.test(params.query)) throw new Error("query must be a nonempty single-line literal of at most 256 characters.");
			if (params.caseSensitive !== undefined && typeof params.caseSensitive !== "boolean") throw new Error("caseSensitive must be a boolean.");
			const limit = integer(params.limit, 50, SOURCE_READ_LIMITS.searchMatches, "limit");
			const timeout = new AbortController();
			const timer = setTimeout(() => timeout.abort(new Error("Source search exceeded its 5-second time limit; narrow the path or query.")), SOURCE_READ_LIMITS.searchMs);
			const cancel = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
			try {
				const checked = await checkedPath(params.path ?? ".", cancel);
				const info = await lstat(checked.absolute);
				if (!info.isFile() && !info.isDirectory()) throw new Error("Search path must be a regular file or directory.");
				const args = ["--no-config", "--json", "--hidden", "--no-follow", "--fixed-strings", `--max-count=${limit + 1}`, `--max-filesize=${SOURCE_READ_LIMITS.fileBytes}`, params.caseSensitive === false ? "--ignore-case" : "--case-sensitive", ...[...excluded].map(name => `--glob=!${name}`), "-e", params.query, "--", checked.path];
				const found = await searchCandidates(canonicalRoot, args, limit, cancel);
				const output = new Output();
				output.truncated = found.truncated;
				let count = 0;
				let skipped = 0;
				const observations: SourceObservation[] = [];
				// Never forward ripgrep's file text. Reopen each bounded file through the
				// source boundary and verify the literal at the reported line before returning it.
				for (const [path, numbers] of found.matches) {
					cancel.throwIfAborted();
					try {
						const file = await readText(path, cancel);
						const id = evidenceId(sourceIdentity, file.path, file.sha256);
						for (const line of numbers) {
							const text = file.lines[line - 1];
							if (text === undefined) continue;
							const position = params.caseSensitive === false ? text.toLowerCase().indexOf(params.query.toLowerCase()) : text.indexOf(params.query);
							if (position < 0) continue;
							const from = Math.max(0, position - 80);
							if (!output.add(`${observe ? `[${id}] ` : ""}${file.path}:${line}: ${from ? "[line excerpt] " : ""}${snippet(text.slice(from))}`)) break;
							if (observe) observations.push({ evidenceId: id, path: file.path, sha256: file.sha256, line, text: text.slice(from, from + 1200), complete: from === 0 && text.length <= 1200 });
							count++;
						}
					} catch (error) { cancel.throwIfAborted(); skipped++; }
				}
				if (skipped) output.add(`[${skipped} files could not be verified or read and were omitted.]`);
				cancel.throwIfAborted();
				for (const observation of observations) observe?.(observation);
				return { content: [{ type: "text", text: output.text() || "No matches in readable source files." }], details: { path: checked.path, matches: count, skipped, truncated: output.truncated } };
			} finally { clearTimeout(timer); }
		},
	};
	return { tools: [list, read, search], verify: async (path, sha256, signal) => {
		if ((await readText(path, signal)).sha256 !== sha256) throw new Error(`Evidence file ${path} changed since it was read; read it again and update its citations.`);
	} };
}

function searchCandidates(cwd: string, args: string[], limit: number, signal: AbortSignal): Promise<{ matches: Map<string, number[]>; truncated: boolean }> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(ripgrepBinary(), args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const matches = new Map<string, number[]>();
		let done = false;
		let truncated = false;
		let buffer = "";
		let bytes = 0;
		let count = 0;
		let stderr = "";
		const finish = (error?: Error) => {
			if (done) return;
			done = true;
			signal.removeEventListener("abort", aborted);
			if (error) reject(error); else resolve({ matches, truncated });
		};
		const stop = () => { child.kill("SIGKILL"); };
		const aborted = () => { stop(); finish(signal.reason instanceof Error ? signal.reason : new Error("Source search aborted.")); };
		signal.addEventListener("abort", aborted, { once: true });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (done || truncated) return;
			bytes += Buffer.byteLength(chunk);
			if (bytes > SOURCE_READ_LIMITS.searchBytes) { truncated = true; stop(); return; }
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const match = parseRipgrepLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (!match) continue;
				if (count >= limit) { truncated = true; stop(); return; }
				const lines = matches.get(match.path) ?? [];
				lines.push(match.line); matches.set(match.path, lines); count++;
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
		child.on("error", error => finish(new Error(`Source search could not start: ${error.message}`)));
		child.on("close", code => finish(code !== 0 && code !== 1 && !truncated ? new Error(`Source search failed: ${stderr.trim() || `exit ${code}`}`) : undefined));
		if (signal.aborted) aborted();
	});
}
