import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createKnowledgeSourceReader, knowledgeRelativePath } from "./knowledge-source-reader.js";
import type { GraphDocumentReview } from "./protocol.js";

interface GraphDocumentContext {
	library(): string | null;
	sources(): { id: string; root: string }[];
	findNode(sourceId: string, path: string, sha256: string): Promise<string | undefined>;
}

const maxItems = 32, maxHeaderBytes = 64 * 1024, maxSourceBytes = 8 * 1024 * 1024;

function readHeader(lines: string[]): { items: unknown[]; truncated: boolean } {
	if (lines[0] !== "---") return { items: [], truncated: false };
	let bytes = 4;
	for (let idx = 1; idx < lines.length; idx++) {
		bytes += Buffer.byteLength(lines[idx]) + 1;
		if (bytes > maxHeaderBytes) return { items: [], truncated: true };
		if (!["...", "---"].includes(lines[idx])) continue;
		const text = [...lines.slice(0, idx), "---"].join("\n");
		try {
			const refs = parseFrontmatter<{ sources?: unknown }>(text).frontmatter.sources;
			return { items: Array.isArray(refs) ? refs : refs === undefined ? [] : [refs], truncated: false };
		} catch { return { items: [], truncated: false }; }
	}
	return { items: [], truncated: false };
}

function lineRange(value: unknown) {
	if (typeof value !== "string" && typeof value !== "number") return;
	const match = /^([1-9]\d{0,8})(?:-([1-9]\d{0,8}))?$/.exec(String(value));
	if (!match) return;
	const line = Number(match[1]), endLine = Number(match[2] ?? match[1]);
	if (endLine >= line) return { line, endLine };
}

export async function reviewGraphDocument(path: string, context: GraphDocumentContext): Promise<GraphDocumentReview> {
	const library = context.library();
	if (!library || !/\.(md|markdown)$/i.test(path)) throw Error("Knowledge document is unavailable.");
	const initial = new Map(context.sources().map(s => [s.id, s.root]));
	const sameLibrary = () => {
		if (context.library() !== library) throw Error("Knowledge library changed. Retry.");
	};
	const visible = (id: string) => initial.has(id) && context.sources().some(s => s.id === id && s.root === initial.get(id));
	const document = async () => {
		sameLibrary();
		try { return await (await createKnowledgeSourceReader(library)).readText(knowledgeRelativePath(path)); }
		catch { throw Error("Knowledge document is unavailable."); }
	};
	const first = await document();
	sameLibrary();
	const { items, truncated } = readHeader(first.lines);
	const result: GraphDocumentReview = { path: first.path, references: [], truncated };
	const files = new Map<string, { sha256: string; count: number } | undefined>();
	const nodes = new Map<string, string | undefined>();
	let bytes = 0;
	for (const item of items) {
		sameLibrary();
		const ref = item && typeof item === "object" ? item as Record<string, unknown> : {};
		// Learn also records session provenance. It has no code location to check.
		if (typeof ref.session === "string" && !("sourceId" in ref)) continue;
		if (result.references.length >= maxItems) { result.truncated = true; break; }
		const sourceId = ref.sourceId;
		if (typeof sourceId !== "string") { result.references.push({ state: "unverified" }); continue; }
		if (!visible(sourceId)) { result.references.push({ state: "unavailable" }); continue; }
		const range = lineRange(ref.lines);
		if (!range || typeof ref.sha256 !== "string" || !/^[\da-f]{64}$/i.test(ref.sha256) || typeof ref.path !== "string") {
			result.references.push({ state: "unverified" });
			continue;
		}
		let relative: string;
		try { relative = knowledgeRelativePath(ref.path); }
		catch { result.references.push({ state: "unavailable" }); continue; }
		const key = JSON.stringify([sourceId, relative]);
		if (!files.has(key)) {
			if (bytes >= maxSourceBytes) { result.truncated = true; break; }
			const root = initial.get(sourceId)!;
			try {
				const source = await (await createKnowledgeSourceReader(root)).readText(relative);
				bytes += source.size;
				if (bytes > maxSourceBytes) { result.truncated = true; break; }
				files.set(key, { sha256: source.sha256, count: source.lines.length });
			} catch { files.set(key, undefined); }
		}
		sameLibrary();
		const source = files.get(key);
		if (!source || !visible(sourceId)) { result.references.push({ state: "unavailable" }); continue; }
		const location = { sourceId, path: relative, ...range };
		if (source.sha256 !== ref.sha256.toLowerCase()) result.references.push({ state: "stale", ...location });
		else if (range.endLine > source.count) result.references.push({ state: "unverified" });
		else {
			if (!nodes.has(key)) {
				try { nodes.set(key, await context.findNode(sourceId, relative, source.sha256)); }
				catch { nodes.set(key, undefined); }
			}
			const nodeId = nodes.get(key);
			result.references.push({ state: "verified", ...location, ...(nodeId ? { nodeId } : {}) });
		}
	}
	if (!result.references.length) result.references.push({ state: "unverified" });
	if ((await document()).sha256 !== first.sha256) throw Error("Knowledge document changed. Retry.");
	sameLibrary();
	result.references = result.references.map(ref => ref.sourceId && !visible(ref.sourceId) ? { state: "unavailable" } : ref);
	return result;
}
