import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseRipgrepLine, ripgrepBinary } from "./code-search.js";
import { decodeText, looksLikeText } from "./text-sniff.js";

export const KNOWLEDGE_READ_LIMITS = {
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

const excluded = new Set([".git", ".ssh", ".aws", ".gnupg", "node_modules", "dist", "build", "coverage", ".next", ".cache", "target", ".venv", "__pycache__"]);
const secretFile = /^(?:\.env.*|auth\.json|models\.json|mcp\.json|id_rsa.*|id_dsa.*|id_ecdsa.*|id_ed25519.*|.*credentials.*|.*secrets?.*|.*\.(?:key|pem|p12|pfx|jks|keystore))$/i;
const pathSchema = Type.String({ minLength: 1, maxLength: KNOWLEDGE_READ_LIMITS.pathChars, description: "Source-relative path; no absolute paths, traversal, symbolic links or credential files." });

export interface KnowledgeEvidenceInput {
	path: string;
	startLine: number;
	endLine: number;
	sha256: string;
}

export interface KnowledgeReadHooks {
	evidence?: (input: KnowledgeEvidenceInput) => Promise<string | undefined>;
}

export interface KnowledgeTextFile {
	path: string;
	lines: string[];
	sha256: string;
	size: number;
}

function sensitivePath(value: string): boolean {
	return value.split("/").some(part => excluded.has(part.toLowerCase()) || secretFile.test(part));
}

export function knowledgeRelativePath(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > KNOWLEDGE_READ_LIMITS.pathChars || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid source-relative path.");
	if (isAbsolute(value) || win32.isAbsolute(value) || /^[a-z]:/i.test(value) || value.includes("\\")) throw new Error("Use a source-relative path with forward slashes.");
	const parts = value.split("/");
	if (parts.includes("..")) throw new Error("Parent traversal is outside the source boundary.");
	if (parts.some(part => sensitivePath(part.toLowerCase()) || sensitivePath(part))) throw new Error("Dependency, generated, version-control and credential paths are not available.");
	return parts.filter(part => part && part !== ".").join("/") || ".";
}

function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

class Output {
	private lines: string[] = [];
	constructor(private bytes = 0) {}
	truncated = false;
	fits(line: string, reserve = 0): boolean {
		return this.bytes + Buffer.byteLength(line) + 1 + reserve <= KNOWLEDGE_READ_LIMITS.outputBytes - 200;
	}
	add(line: string): boolean {
		if (!this.fits(line)) { this.truncated = true; return false; }
		this.lines.push(line); this.bytes += Buffer.byteLength(line) + 1; return true;
	}
	text(): string { return this.lines.join("\n") + (this.truncated ? "\n[Results truncated. Narrow the path/query or request a smaller line range.]" : ""); }
}

function snippet(line: string): string {
	return line.length > 1200 ? `${line.slice(0, 1200)} [line truncated]` : line;
}

function integer(value: unknown, fallback: number, max: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}.`);
	return value;
}

export async function createKnowledgeSourceReader(root: string, hooks: KnowledgeReadHooks = {}) {
	const canonicalRoot = await realpath(root);
	const rootIdentity = await stat(canonicalRoot);
	if (!rootIdentity.isDirectory()) throw new Error("Source root must be a directory.");
	const checkedPath = async (input: unknown, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		const path = knowledgeRelativePath(input);
		const currentRoot = await lstat(canonicalRoot);
		if (!currentRoot.isDirectory() || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino || await realpath(root) !== canonicalRoot || await realpath(canonicalRoot) !== canonicalRoot) throw new Error("Source root changed; refresh the registered source.");
		let absolute = canonicalRoot;
		for (const part of path === "." ? [] : path.split("/")) {
			signal?.throwIfAborted();
			absolute = resolve(absolute, part);
			if ((await lstat(absolute)).isSymbolicLink()) throw new Error("Symbolic links are not available to source readers.");
		}
		const actual = await realpath(absolute);
		if (!isWithin(canonicalRoot, actual)) throw new Error("Path is outside the source boundary.");
		const actualRelative = relative(canonicalRoot, actual).split(sep).join("/") || ".";
		knowledgeRelativePath(actualRelative);
		signal?.throwIfAborted();
		return { path: actualRelative, absolute: actual };
	};

	const readText = async (input: unknown, signal?: AbortSignal): Promise<KnowledgeTextFile> => {
		const checked = await checkedPath(input, signal);
		const before = await lstat(checked.absolute);
		if (!before.isFile()) throw new Error("Source reads require a regular text file.");
		if (before.size > KNOWLEDGE_READ_LIMITS.fileBytes) throw new Error("Source file exceeds the 1 MiB reading limit.");
		const file = await open(checked.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const opened = await file.stat();
			const verified = await checkedPath(checked.path, signal);
			const after = await lstat(verified.absolute);
			if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== after.dev || opened.ino !== after.ino) throw new Error("Source file changed while opening; retry the read.");
			if (opened.size > KNOWLEDGE_READ_LIMITS.fileBytes) throw new Error("Source file exceeds the 1 MiB reading limit.");
			const chunks: Buffer[] = [];
			let size = 0;
			while (true) {
				signal?.throwIfAborted();
				const chunk = Buffer.alloc(Math.min(65536, KNOWLEDGE_READ_LIMITS.fileBytes + 1 - size));
				const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
				if (!bytesRead) break;
				size += bytesRead;
				if (size > KNOWLEDGE_READ_LIMITS.fileBytes) throw new Error("Source file exceeds the 1 MiB reading limit.");
				chunks.push(chunk.subarray(0, bytesRead));
			}
			signal?.throwIfAborted();
			const finalPath = await checkedPath(checked.path, signal);
			const final = await lstat(finalPath.absolute);
			if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== size || opened.size !== size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) throw new Error("Source file changed while reading; retry the read.");
			const bytes = Buffer.concat(chunks);
			if (!looksLikeText(bytes)) throw new Error("Source file is binary; only text/code/Markdown can be read.");
			const lines = decodeText(bytes).split("\n");
			if (!bytes.length || bytes.at(-1) === 10) lines.pop();
			return { path: checked.path, lines: lines.map(line => line.replace(/\r$/, "")), sha256: createHash("sha256").update(bytes).digest("hex"), size };
		} finally { await file.close(); }
	};

	const listParams = Type.Object({ path: Type.Optional(pathSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: KNOWLEDGE_READ_LIMITS.listEntries })) });
	const list: ToolDefinition<typeof listParams> = {
		name: "source_list", label: "List source", description: "List immediate files/directories in one authorized source (default '.', at most 200 entries). No credentials, symbolic links, dependencies or generated directories.", parameters: listParams,
		execute: async (_id, params, signal) => {
			const limit = integer(params.limit, 100, KNOWLEDGE_READ_LIMITS.listEntries, "limit");
			const checked = await checkedPath(params.path ?? ".", signal);
			const output = new Output(), entries: string[] = [];
			const directory = await opendir(checked.absolute);
			for await (const entry of directory) {
				signal?.throwIfAborted();
				const child = `${checked.path === "." ? "" : `${checked.path}/`}${entry.name}`;
				if (sensitivePath(child) || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || /[\x00-\x1f\x7f]/.test(entry.name)) continue;
				if (entries.length >= limit) { output.truncated = true; break; }
				entries.push(`${child}${entry.isDirectory() ? "/" : ""}`);
			}
			signal?.throwIfAborted();
			for (const entry of entries.sort()) if (!output.add(entry)) break;
			return { content: [{ type: "text", text: output.text() || "No visible entries." }], details: { path: checked.path, truncated: output.truncated } };
		},
	};
	const readParams = Type.Object({ path: pathSchema, startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: KNOWLEDGE_READ_LIMITS.readLines })) });
	const read: ToolDefinition<typeof readParams> = {
		name: "source_read", label: "Read source", description: "Read a text/code/Markdown file in one authorized source, up to 1 MiB. Returns a server evidenceId, source-relative path, original line numbers and SHA-256. Default 150 lines; at most 300 lines and 24 KiB.", parameters: readParams,
		execute: async (_id, params, signal) => {
			const start = integer(params.startLine, 1, 1000000, "startLine");
			const limit = integer(params.limit, 150, KNOWLEDGE_READ_LIMITS.readLines, "limit");
			const file = await readText(params.path, signal);
			const header = `${file.path} (${file.lines.length} lines; SHA-256 ${file.sha256}`;
			const output = new Output(Buffer.byteLength(header) + 64);
			const end = Math.min(file.lines.length, start - 1 + limit);
			let observedEnd = start - 1;
			if (start > file.lines.length) output.add(file.lines.length ? "Requested line is beyond the end of this file." : "Empty file.");
			for (let line = start; line <= end; line++) {
				const text = file.lines[line - 1];
				if (!output.add(`${file.path}:${line}: ${snippet(text)}`)) break;
				if (text.length > 1200) { output.truncated = true; break; }
				observedEnd = line;
			}
			if (end < file.lines.length) output.truncated = true;
			const evidenceId = observedEnd >= start ? await hooks.evidence?.({ path: file.path, startLine: start, endLine: observedEnd, sha256: file.sha256 }) : undefined;
			const text = `${header}${evidenceId ? `; evidenceId ${evidenceId}` : ""})\n${output.text()}`;
			return { content: [{ type: "text", text }], details: { path: file.path, sha256: file.sha256, totalLines: file.lines.length, startLine: start, endLine: observedEnd >= start ? observedEnd : undefined, evidenceId, truncated: output.truncated } };
		},
	};
	const searchParams = Type.Object({ query: Type.String({ minLength: 1, maxLength: KNOWLEDGE_READ_LIMITS.queryChars }), path: Type.Optional(pathSchema), caseSensitive: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: KNOWLEDGE_READ_LIMITS.searchMatches })) });
	const search: ToolDefinition<typeof searchParams> = {
		name: "source_search", label: "Search source", description: "Search a literal, single-line substring in one authorized source. Defaults to case-sensitive, path '.', 50 matches. Maximum 100 matches, 24 KiB and 5 seconds. Hits are reread through the source boundary and include evidence IDs only for complete observed lines.", parameters: searchParams,
		execute: async (_id, params, signal) => {
			if (typeof params.query !== "string" || !params.query || params.query.length > KNOWLEDGE_READ_LIMITS.queryChars || /[\x00\r\n]/.test(params.query)) throw new Error("query must be a nonempty single-line literal of at most 256 characters.");
			if (params.caseSensitive !== undefined && typeof params.caseSensitive !== "boolean") throw new Error("caseSensitive must be a boolean.");
			const limit = integer(params.limit, 50, KNOWLEDGE_READ_LIMITS.searchMatches, "limit");
			const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(new Error("Source search exceeded its 5-second time limit; narrow the path or query.")), KNOWLEDGE_READ_LIMITS.searchMs);
			const cancel = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
			try {
				const checked = await checkedPath(params.path ?? ".", cancel);
				const info = await lstat(checked.absolute);
				if (!info.isFile() && !info.isDirectory()) throw new Error("Search path must be a regular file or directory.");
				const args = ["--no-config", "--json", "--hidden", "--no-follow", "--fixed-strings", `--max-count=${limit + 1}`, `--max-filesize=${KNOWLEDGE_READ_LIMITS.fileBytes}`, params.caseSensitive === false ? "--ignore-case" : "--case-sensitive",
					...[...excluded].map(name => `--glob=!${name}`), "--glob=!.env*", "--glob=!*.key", "--glob=!*.pem", "--glob=!*.p12", "--glob=!*.pfx", "--glob=!*.jks", "--glob=!*.keystore", "--glob=!auth.json", "--glob=!models.json", "--glob=!mcp.json", "--glob=!*credentials*", "--glob=!*secret*", "-e", params.query, "--", checked.path];
				const found = await searchCandidates(canonicalRoot, args, limit, cancel), output = new Output();
				output.truncated = found.truncated;
				let count = 0, skipped = 0;
				for (const [path, numbers] of found.matches) {
					cancel.throwIfAborted();
					try {
						const file = await readText(path, cancel);
						for (const line of numbers) {
							const text = file.lines[line - 1];
							if (text === undefined) continue;
							const position = params.caseSensitive === false ? text.toLowerCase().indexOf(params.query.toLowerCase()) : text.indexOf(params.query);
							if (position < 0) continue;
							const complete = text.length <= 1200, from = complete ? 0 : Math.max(0, position - 80);
							const hit = `${file.path}:${line}: ${from ? "[line excerpt] " : ""}${snippet(text.slice(from))}`;
							if (!output.fits(hit, complete ? 64 : 0)) { output.truncated = true; break; }
							const evidenceId = complete ? await hooks.evidence?.({ path: file.path, startLine: line, endLine: line, sha256: file.sha256 }) : undefined;
							output.add(`${evidenceId ? `[${evidenceId}] ` : ""}${hit}`);
							count++;
						}
					} catch (error) { cancel.throwIfAborted(); skipped++; }
				}
				if (skipped) output.add(`[${skipped} files could not be verified or read and were omitted.]`);
				cancel.throwIfAborted();
				return { content: [{ type: "text", text: output.text() || "No matches in readable source files." }], details: { path: checked.path, matches: count, skipped, truncated: output.truncated } };
			} finally { clearTimeout(timer); }
		},
	};
	return { tools: [list, search, read], readText };
}

function searchCandidates(cwd: string, args: string[], limit: number, signal: AbortSignal): Promise<{ matches: Map<string, number[]>; truncated: boolean }> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(ripgrepBinary(), args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const matches = new Map<string, number[]>();
		let done = false, truncated = false, buffer = "", bytes = 0, count = 0, stderr = "";
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
			if (bytes > KNOWLEDGE_READ_LIMITS.searchBytes) { truncated = true; stop(); return; }
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

export async function readKnowledgeTextFile(root: string, path: string): Promise<KnowledgeTextFile> {
	const reader = await createKnowledgeSourceReader(root);
	return reader.readText(path);
}

export function knowledgeFileName(path: string): string {
	return basename(path);
}
