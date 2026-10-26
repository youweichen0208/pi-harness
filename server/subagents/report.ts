import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSourceReader, type SourceObservation } from "./read-tools.js";

export const SUBAGENT_REPORT_LIMITS = {
	outputBytes: 24 * 1024,
	evidenceBytes: 1024 * 1024,
	evidenceFiles: 256,
	evidenceLines: 8192,
	citationLines: 100,
} as const;

export interface SubagentReportCitation {
	evidenceId: string;
	path: string;
	startLine: number;
	endLine: number;
	sha256: string;
	excerpt: string;
}

export interface SubagentResearchReport {
	summary: string;
	findings: {
		kind: "implementation" | "documentation" | "inference";
		statement: string;
		citations: SubagentReportCitation[];
	}[];
	connections: string[];
	openQuestions: string[];
	/** Provenance was checked at submission; this does not validate the model's conclusions. */
	checkedAt: string;
}

const citationSchema = Type.Object({
	evidenceId: Type.String({ minLength: 1, maxLength: 64 }),
	startLine: Type.Integer({ minimum: 1, maximum: 1000000 }),
	endLine: Type.Integer({ minimum: 1, maximum: 1000000 }),
}, { additionalProperties: false });
const paramsSchema = Type.Object({
	summary: Type.String({ minLength: 1, maxLength: 2000 }),
	findings: Type.Array(Type.Object({
		kind: Type.Union([Type.Literal("implementation"), Type.Literal("documentation"), Type.Literal("inference")]),
		statement: Type.String({ minLength: 1, maxLength: 1000 }),
		citations: Type.Array(citationSchema, { minItems: 1, maxItems: 3 }),
	}, { additionalProperties: false }), { maxItems: 8 }),
	connections: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 8, description: "Entities/interfaces that may connect to other repositories; distinguish unresolved connections from observed facts." }),
	openQuestions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 8 }),
}, { additionalProperties: false });

interface EvidenceFile {
	path: string;
	sha256: string;
	lines: Map<number, { text: string; complete: boolean }>;
}

/** Keep only lines actually returned to the child, not all bytes loaded by a file read. */
export async function createSubagentResearchTools(root: string): Promise<{
	tools: ToolDefinition[];
	getReport: () => SubagentResearchReport | undefined;
	getReportError: () => string | undefined;
	invalidateReport: (reason?: string) => void;
}> {
	const evidence = new Map<string, EvidenceFile>();
	let evidenceBytes = 0, evidenceLines = 0;
	let report: SubagentResearchReport | undefined;
	let reportError: string | undefined;
	const invalidateReport = (reason?: string) => {
		report = undefined;
		reportError = reason?.slice(0, 2000);
	};
	const observe = (item: SourceObservation) => {
		let file = evidence.get(item.evidenceId);
		const previous = file?.lines.get(item.line);
		if (previous?.complete) return;
		const bytes = Buffer.byteLength(item.text) + 32;
		const previousBytes = previous ? Buffer.byteLength(previous.text) + 32 : 0;
		const fileBytes = file ? 0 : Buffer.byteLength(item.path) + 160;
		if ((!file && evidence.size >= SUBAGENT_REPORT_LIMITS.evidenceFiles) || (!previous && evidenceLines >= SUBAGENT_REPORT_LIMITS.evidenceLines) || evidenceBytes + bytes - previousBytes + fileBytes > SUBAGENT_REPORT_LIMITS.evidenceBytes) return;
		if (!file) {
			file = { path: item.path, sha256: item.sha256, lines: new Map() };
			evidence.set(item.evidenceId, file);
		}
		file.lines.set(item.line, { text: item.text, complete: item.complete });
		evidenceBytes += bytes - previousBytes + fileBytes;
		if (!previous) evidenceLines++;
	};
	const reader = await createSourceReader(root, observe);
	const submit: ToolDefinition<typeof paramsSchema> = {
		name: "source_report",
		label: "Submit source report",
		executionMode: "sequential",
		description: "Submit a structured research report before finishing. Each finding must identify implementation, documentation or inference and cite evidenceId plus an inclusive startLine/endLine range from source_read/source_search output. Only complete lines you actually received can be cited; search excerpts or truncated lines cannot support full-line citations. Read missing lines first. At most 8 findings, 3 citations each, 100 lines per citation and 24 KiB total report. Evidence files are rechecked for changes. Errors permit correction; an invalid submission removes any previous report. Connections and open questions are brief leads for the parent. Acceptance checks evidence provenance/text, not whether conclusions are correct. Never fabricate evidence IDs, paths, quotations or findings when evidence is unavailable.",
		parameters: paramsSchema,
		execute: async (_id, params, signal) => {
			invalidateReport();
			try {
				signal?.throwIfAborted();
				if (!Check(paramsSchema, params)) {
					const first = [...Errors(paramsSchema, params)][0];
					throw new Error(`Invalid report fields: ${first?.instancePath || "/"} ${first?.message || "check the source_report schema"}.`);
				}
				const citedFiles = new Map<string, EvidenceFile>();
				const findings = params.findings.map(finding => ({
					kind: finding.kind,
					statement: finding.statement,
					citations: finding.citations.map(citation => {
						const file = evidence.get(citation.evidenceId);
						if (!file) throw new Error(`Unknown or unretained evidenceId ${citation.evidenceId}; cite an ID returned by a source read/search. The evidence registry is bounded; narrow this task if it is full.`);
						if (citation.endLine < citation.startLine || citation.endLine - citation.startLine + 1 > SUBAGENT_REPORT_LIMITS.citationLines) throw new Error("Citation ranges must be ordered and contain at most 100 lines.");
						const lines: string[] = [];
						for (let line = citation.startLine; line <= citation.endLine; line++) {
							const observed = file.lines.get(line);
							if (!observed) throw new Error(`${file.path}:${line} was not returned to you. Read the missing range before citing it.`);
							if (!observed.complete) throw new Error(`${file.path}:${line} was only a partial or truncated line. Only complete observed lines can be cited; choose other evidence.`);
							lines.push(observed.text);
						}
						citedFiles.set(citation.evidenceId, file);
						return { ...citation, path: file.path, sha256: file.sha256, excerpt: lines.join("\n") };
					}),
				}));
				const candidate: SubagentResearchReport = { summary: params.summary, findings, connections: [...params.connections], openQuestions: [...params.openQuestions], checkedAt: new Date().toISOString() };
				if (Buffer.byteLength(JSON.stringify(candidate)) > SUBAGENT_REPORT_LIMITS.outputBytes) throw new Error("Report exceeds 24 KiB including cited excerpts. Shorten statements or use smaller citation ranges.");
				for (const file of citedFiles.values()) await reader.verify(file.path, file.sha256, signal);
				signal?.throwIfAborted();
				candidate.checkedAt = new Date().toISOString();
				report = candidate;
				return { content: [{ type: "text", text: `Report accepted: ${findings.length} findings. ${findings.length ? `Cited source text and fingerprints checked at ${candidate.checkedAt}. The parent will receive the report with exact excerpts. This does not validate conclusions.` : "No cited findings; evidence remains unverified. Explain the missing evidence in openQuestions."}` }], details: { accepted: true, checkedAt: candidate.checkedAt, findings: findings.length } };
			} catch (error) {
				reportError = String(error instanceof Error ? error.message : error).slice(0, 2000);
				signal?.throwIfAborted();
				return { content: [{ type: "text", text: `Report not accepted: ${reportError}` }], details: { accepted: false, error: reportError } };
			}
		},
	};
	return { tools: [...reader.tools, submit], getReport: () => report ? structuredClone(report) : undefined, getReportError: () => reportError, invalidateReport };
}
