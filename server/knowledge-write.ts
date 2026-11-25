import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Type } from "typebox";
import { generateUnifiedPatch, parseFrontmatter, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { KnowledgeToolHost } from "./knowledge-host.js";
import type { KnowledgeEvidence, KnowledgeRequestContext } from "./knowledge-requests.js";
import { assertKnowledgeSourceAccess } from "./knowledge-sources.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => JSON.stringify(value);

interface KnowledgeDocumentInput {
	path: string;
	text: string;
	expectedVersion?: string;
	evidenceIds?: string[];
	title?: string;
	type?: string;
	tags?: string[];
	status?: "verified" | "inferred" | "unverified";
}

function localDate(now = new Date()): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function fieldRange(lines: string[], name: string): { start: number; end: number } | undefined {
	const start = lines.findIndex(line => new RegExp(`^${name}\\s*:`).test(line));
	if (start < 0) return undefined;
	let end = start + 1;
	while (end < lines.length && !/^\S[^:]*:/.test(lines[end]) && lines[end].trim() !== "---" && lines[end].trim() !== "...") end++;
	return { start, end };
}

function removeField(lines: string[], name: string): string[] {
	const range = fieldRange(lines, name);
	if (!range) return lines;
	return [...lines.slice(0, range.start), ...lines.slice(range.end)];
}

function evidenceBlock(evidence: KnowledgeEvidence): string[] {
	return [
		`  - sourceId: ${quote(evidence.source.id)}`,
		`    path: ${quote(evidence.path)}`,
		`    lines: ${quote(evidence.startLine === evidence.endLine ? String(evidence.startLine) : `${evidence.startLine}-${evidence.endLine}`)}`,
		`    sha256: ${quote(evidence.fingerprint)}`,
		`    revision: ${quote(evidence.revision ?? "unknown")}`,
		`    workingTree: ${quote(evidence.workingTree)}`,
	];
}

function documentParts(text: string) {
	const lines = text.split(/\r?\n/);
	if (lines[0] !== "---") return { frontmatter: [] as string[], body: lines };
	const end = lines.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
	if (end < 0) throw new Error("Knowledge frontmatter is missing its closing delimiter");
	return { frontmatter: lines.slice(1, end), body: lines.slice(end + 1) };
}

function prepareKnowledgeText(input: KnowledgeDocumentInput, context: KnowledgeRequestContext, oldText: string | null, now = new Date()): { text: string; unchanged: boolean } {
	const evidence = [...new Set(input.evidenceIds ?? [])].map(id => {
		const found = context.evidence.get(id);
		if (!found || found.requestId !== context.requestId) throw new Error(`Unknown evidenceId ${id}; cite only evidence returned in this Learn request`);
		return found;
	});
	const old = documentParts(oldText ?? "");
	const proposal = documentParts(input.text), body = proposal.body;
	const newline = (oldText ?? input.text).includes("\r\n") ? "\r\n" : "\n";
	let frontmatter = [...proposal.frontmatter];
	// Partial frontmatter may omit the library's existing classification or custom fields.
	if (frontmatter.length === 0) frontmatter = [...old.frontmatter];
	else {
		for (const line of old.frontmatter) {
			const key = /^([\w-]+):/.exec(line)?.[1];
			if (!key || fieldRange(frontmatter, key)) continue;
			const range = fieldRange(old.frontmatter, key)!;
			frontmatter.push(...old.frontmatter.slice(range.start, range.end));
		}
	}
	const firstHeading = body.find(line => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim();
	const values = {
		title: input.title ?? firstHeading ?? basename(input.path).replace(/\.(?:md|markdown)$/i, ""),
		type: input.type ?? "knowledge",
		tags: input.tags ?? [],
		status: input.status ?? "unverified",
	};
	for (const name of ["title", "type", "tags", "status"] as const) {
		const range = fieldRange(frontmatter, name);
		if (range && input[name] === undefined) continue;
		const value = name === "tags" ? `[${values.tags.map(quote).join(", ")}]` : values[name];
		const line = `${name}: ${name === "tags" ? value : quote(value)}`;
		if (range) frontmatter = [...frontmatter.slice(0, range.start), line, ...frontmatter.slice(range.end)];
		else frontmatter.unshift(line);
	}
	// Provenance comes from disk and this request's actual evidence, never from proposed YAML.
	const prior = parseFrontmatter<{ sources?: unknown }>(oldText ?? "").frontmatter.sources;
	const previousSources: unknown[] = prior === undefined ? [] : Array.isArray(prior) ? [...prior] : [prior];
	const sources = fieldRange(old.frontmatter, "sources");
	const oldHeader = sources ? old.frontmatter.slice(sources.start, sources.end) : [];
	const additions: string[] = [];
	for (const item of evidence) {
		const lines = item.startLine === item.endLine ? String(item.startLine) : `${item.startLine}-${item.endLine}`;
		const matches = previousSources.some(value => {
			const ref = value as Partial<{ sourceId: string; path: string; sha256: string; lines: string }> | null;
			return ref?.sourceId === item.source.id && ref.path === item.path && ref.sha256 === item.fingerprint && String(ref.lines) === lines;
		});
		if (!matches) {
			additions.push(...evidenceBlock(item));
			previousSources.push({ sourceId: item.source.id, path: item.path, lines, sha256: item.fingerprint });
		}
	}
	const unmanaged = (header: string[]) => removeField(removeField(header, "sources"), "updated");
	frontmatter = unmanaged(frontmatter);
	const status = parseFrontmatter<{ status?: unknown }>(["---", ...frontmatter, "---"].join("\n")).frontmatter.status;
	if (!["verified", "inferred", "unverified"].includes(String(status))) throw new Error("Invalid knowledge status");
	const sameHeader = JSON.stringify(unmanaged(old.frontmatter)) === JSON.stringify(frontmatter);
	if (oldText !== null && sameHeader && old.body.join("\n") === body.join("\n") && !additions.length) return { text: oldText, unchanged: true };
	if (!previousSources.some(value => (value as { session?: string } | null)?.session === context.sessionId)) additions.unshift(`  - session: ${quote(context.sessionId)}`);
	if (oldHeader.length && !additions.length) frontmatter.push(...oldHeader);
	else {
		frontmatter.push("sources:");
		if (oldHeader.length && /^sources:\s*$/.test(oldHeader[0])) frontmatter.push(...oldHeader.slice(1));
		else if (prior !== undefined) for (const value of Array.isArray(prior) ? prior : [prior]) frontmatter.push("  - " + JSON.stringify(value));
		frontmatter.push(...additions);
	}
	frontmatter.push(`updated: ${localDate(now)}`);
	return { text: ["---", ...frontmatter, "---", ...body].join(newline), unchanged: false };
}

export function createKnowledgeWriteTool(host: KnowledgeToolHost): ToolDefinition {
	const parameters = Type.Object({
		path: Type.String({ minLength: 1, maxLength: 2048, description: "Knowledge-library-relative .md/.markdown path; parent directories must already exist." }),
		text: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024, description: "Complete target document. Preserve unrelated metadata and prose when updating." }),
		expectedVersion: Type.Optional(Type.String({ description: "SHA-256 returned by source_read for an existing document; omit only when creating a new file." })),
		evidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 64, description: "Server evidence IDs supporting this entry, returned in this Learn request." })),
		title: Type.Optional(Type.String({ maxLength: 200 })),
		type: Type.Optional(Type.String({ maxLength: 80 })),
		tags: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 32 })),
		status: Type.Optional(Type.Union([Type.Literal("verified"), Type.Literal("inferred"), Type.Literal("unverified")])),
	});
	return {
		name: "knowledge_write", label: "Review and save knowledge", defaultActive: false, executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		description: "Prepare one Markdown knowledge entry, show its exact server-generated diff, and save only after the user approves. Updates require expectedVersion. Each document needs separate approval.",
		parameters,
		async execute(_id, raw, signal, _update, ctx) {
			const input = raw as KnowledgeDocumentInput, context = host.getContext();
			if (!context || context.mode !== "learn") throw new Error("knowledge_write is available only in an active Learn request");
			const library = context.scope.sources.find(entry => entry.kind === "knowledge");
			if (!library) throw new Error("Configure a knowledge library before saving");
			assertKnowledgeSourceAccess(context.scope, library.id, host.sourceState());
			const { current } = host.wiki.knowledgeDocument(library.root, input.path, host.skillFiles?.());
			const oldText = current?.toString("utf8") ?? null;
			if (input.expectedVersion !== undefined && (!current || hash(oldText!) !== input.expectedVersion)) throw new Error("The document changed; reread it before approval");
			const prepared = prepareKnowledgeText(input, context, oldText);
			if (prepared.unchanged || oldText === prepared.text) return { content: [{ type: "text", text: JSON.stringify({ status: "unchanged", path: input.path, diskWritten: false }) }], details: {} };
			if (current && !input.expectedVersion) throw new Error("expectedVersion is required when updating an existing document");
			const patch = generateUnifiedPatch(input.path, oldText ?? "", prepared.text, 3);
			const approved = await ctx.ui.confirm("Approve knowledge entry", `${input.path}\n\n${patch}`, { signal });
			if (!approved) return { content: [{ type: "text", text: JSON.stringify({ status: "cancelled", path: input.path, diskWritten: false }) }], details: {} };
			signal?.throwIfAborted();
			if (host.getContext() !== context) throw new Error("The Learn request changed; approval is no longer valid");
			assertKnowledgeSourceAccess(context.scope, library.id, host.sourceState());
			const result = host.wiki.writeKnowledgeDocument(library.root, input.path, prepared.text, input.expectedVersion ?? null, {
				conversationId: context.conversationId, sessionId: context.sessionId, requestId: context.requestId,
			}, host.skillFiles?.());
			return { content: [{ type: "text", text: JSON.stringify({ ...result, path: input.path }) }], details: {} };
		},
	};
}
