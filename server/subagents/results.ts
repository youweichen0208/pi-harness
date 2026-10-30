import type { SubagentResult } from "./runner.js";

export const SUBAGENT_RESULT_LIMITS = {
	sources: 8,
	/** Leave another 4 KiB within the tool's 64 KiB budget for Workspace metadata. */
	outputBytes: 60 * 1024,
	taskChars: 240,
} as const;

export interface ProjectedSubagentResult extends SubagentResult {
	outputTruncated?: true;
	omittedFindings?: number;
	omittedConnections?: number;
	omittedOpenQuestions?: number;
}

function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

function clip(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= maxBytes) return text;
	let end = maxBytes - Buffer.byteLength("…");
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return `${buffer.subarray(0, end).toString("utf8")}…`;
}

function mark(result: ProjectedSubagentResult): void {
	result.truncated = true;
	result.outputTruncated = true;
}

function shorten(result: ProjectedSubagentResult, field: "text" | "task", maxBytes: number): boolean {
	const next = clip(result[field], maxBytes);
	if (next === result[field]) return false;
	result[field] = next; mark(result);
	return true;
}

function warning(result: ProjectedSubagentResult, original?: string): void {
	const messages = original ? [clip(original, 1024)] : [];
	if (result.outputTruncated) messages.push("Output shortened; omitted counts identify missing report sections. Narrow follow-up research to those gaps.");
	if (result.report && !result.report.findings.some(finding => finding.citations.length)) {
		result.evidenceStatus = "unverified";
		messages.push("No cited findings are retained in this result; summary and other prose are unverified leads.");
	}
	result.evidenceWarning = messages.length ? messages.join(" ") : undefined;
}

/** Shrink prose across the entire batch before removing any cited findings. */
function shrinkProse(result: ProjectedSubagentResult): boolean {
	const report = result.report;
	if (shorten(result, "text", report ? 800 : 6 * 1024)) {
		return true;
	} else if (!result.outputTruncated && result.evidenceWarning && Buffer.byteLength(result.evidenceWarning) > 1024) {
		// warning() clips the original warning after this projection step.
		mark(result);
	} else if (report && Buffer.byteLength(report.summary) > 800) {
		report.summary = clip(report.summary, 800);
	} else if (report?.connections.length) {
		report.connections.pop(); result.omittedConnections = (result.omittedConnections ?? 0) + 1;
	} else if (shorten(result, "text", 384)) {
		return true;
	} else if (report?.openQuestions.length) {
		report.openQuestions.pop(); result.omittedOpenQuestions = (result.omittedOpenQuestions ?? 0) + 1;
	} else if (report && Buffer.byteLength(report.summary) > 240) {
		report.summary = clip(report.summary, 240);
	} else if (shorten(result, "text", 240) || shorten(result, "task", 80)) {
		return true;
	} else {
		return false;
	}
	mark(result);
	return true;
}

/** Retained findings keep exact citation objects, quotes and checkedAt. */
function shrinkFindings(result: ProjectedSubagentResult): boolean {
	if (!result.report?.findings.length) return false;
	result.report.findings.pop();
	result.omittedFindings = (result.omittedFindings ?? 0) + 1;
	mark(result);
	return true;
}

/** Project only the parent-visible content. Callers retain the original result
 * in native tool details; this never mutates it or changes a source's identity.
 * Reports share the entire 60 KiB budget, including the results wrapper. */
export function projectSubagentResults(results: SubagentResult[]): ProjectedSubagentResult[] {
	if (results.length > SUBAGENT_RESULT_LIMITS.sources) throw new Error("Project at most 8 subagent results per batch.");
	const projected: ProjectedSubagentResult[] = structuredClone(results);
	const originals = results.map(result => result.evidenceWarning);
	for (const result of projected) {
		const task = Array.from(result.task);
		if (task.length > SUBAGENT_RESULT_LIMITS.taskChars) {
			result.task = `${task.slice(0, SUBAGENT_RESULT_LIMITS.taskChars - 1).join("")}…`;
			// This is only an echoed task preview, not missing research output.
		}
	}
	while (bytes({ results: projected }) > SUBAGENT_RESULT_LIMITS.outputBytes) {
		const order = projected.map((result, index) => ({ result, index })).sort((a, b) => bytes(b.result) - bytes(a.result));
		const next = order.find(({ result }) => shrinkProse(result)) ?? order.find(({ result }) => shrinkFindings(result));
		if (!next) throw new Error("Subagent source identities exceed the result output limit; use a smaller batch.");
		warning(next.result, originals[next.index]);
	}
	return projected;
}
