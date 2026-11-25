import { randomUUID } from "node:crypto";
import { Type, type TObject } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createKnowledgeSourceReader, type KnowledgeEvidenceInput } from "./knowledge-source-reader.js";
import { gitFileEvidence } from "./knowledge-sources.js";
import type { KnowledgeSource } from "./knowledge-requests.js";

interface Observation extends KnowledgeEvidenceInput { sourceId: string }
interface Citation extends Observation {
	repository: string;
	revision?: string;
	workingTree: "clean" | "modified" | "untracked" | "unknown";
}
export interface InvestigationReport {
	findings: { finding: string; evidence: Citation[] }[];
	uncertainties: string[];
	truncated: boolean;
}

const params = Type.Object({
	findings: Type.Array(Type.Object({
		finding: Type.String({ minLength: 1, maxLength: 600 }),
		evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 3, uniqueItems: true }),
	}), { maxItems: 4 }),
	uncertainties: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 4 }),
});

/** Each child owns its observation ledger. Only complete lines delivered by this child's tools can be cited. */
export async function createInvestigationReportTools(sourceIds: string[], authorize: (id: string) => KnowledgeSource, signal: AbortSignal) {
	const readers = new Map<string, Awaited<ReturnType<typeof createKnowledgeSourceReader>>>();
	const observed = new Map<string, Observation>();
	// All child tools are sequential. Promote IDs after the result has passed its output limit.
	const pending = new Map<string, Observation>();
	const inspected = new Set<string>();
	const readFailures = new Set<string>();
	let truncated = false;
	let report: InvestigationReport | undefined, lastIssue: string | undefined;
	for (const sourceId of sourceIds) {
		const source = authorize(sourceId);
		const reader = await createKnowledgeSourceReader(source.root, {
			evidence: async observation => {
				if (observed.size + pending.size >= 256) { truncated = true; return undefined; }
				const id = `ce_${randomUUID()}`;
				pending.set(id, { ...observation, sourceId });
				return id;
			},
		});
		readers.set(sourceId, reader);
	}

	const tools: ToolDefinition[] = readers.get(sourceIds[0])!.tools.map(def => ({
		name: def.name, label: def.label, description: def.description, executionMode: "sequential",
		parameters: Type.Object({ ...(def.parameters as TObject).properties, sourceId: Type.String({ description: "One of this investigation's selected source IDs." }) }),
		execute: async (id, input, toolSignal, update, ctx) => {
			const { sourceId, ...args } = input as Record<string, unknown>;
			const reader = typeof sourceId === "string" ? readers.get(sourceId) : undefined;
			if (!reader || typeof sourceId !== "string") throw new Error("Source outside this investigation");
			const local = reader.tools.find(entry => entry.name === def.name)!;
			const cancel = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal;
			cancel.throwIfAborted();
			authorize(sourceId);
			pending.clear();
			const result = await local.execute(id, args as never, cancel, update, ctx).catch(error => {
				if (readFailures.size < 4) readFailures.add(`${sourceId}/${def.name}: ${String(error).slice(0, 160)}`);
				else truncated = true;
				throw error;
			});
			cancel.throwIfAborted();
			authorize(sourceId);
			const text = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
			for (const [key, observation] of pending) if (text.includes(key)) observed.set(key, observation);
			pending.clear();
			inspected.add(sourceId);
			const details = result.details as { truncated?: boolean; skipped?: number };
			truncated ||= details.truncated === true;
			if (details.skipped && readFailures.size < 4) readFailures.add(`${sourceId}/${def.name}: ${details.skipped} file(s) could not be verified`);
			return result;
		},
	}));
	const submit: ToolDefinition<typeof params> = {
		name: "source_report", label: "Submit verified findings", executionMode: "sequential",
		description: "Submit findings supported by your observed evidence IDs and remaining uncertainties. If inspected sources contain no relevant evidence, submit empty findings and a specific uncertainty.",
		parameters: params,
		execute: async (_id, input) => {
			report = undefined;
			try {
				signal.throwIfAborted();
				if (!inspected.size) throw new Error("Inspect a selected source before submitting a report");
				if (!input.findings.length && !input.uncertainties.length) throw new Error("Report an uncertainty if evidence is insufficient");
				const citations = new Map<string, Citation>();
				for (const key of new Set(input.findings.flatMap(finding => finding.evidenceIds))) {
					const item = observed.get(key);
					if (!item) throw new Error("Unknown or undelivered evidence ID; read the lines in this investigation");
					const source = authorize(item.sourceId);
					const file = await readers.get(item.sourceId)!.readText(item.path, signal);
					if (file.path !== item.path || file.sha256 !== item.sha256 || item.endLine > file.lines.length || item.startLine < 1 || item.startLine > item.endLine) {
						throw new Error(`Stale evidence in ${item.path}; reread before submitting`);
					}
					const git = await gitFileEvidence(source.root, file.path);
					authorize(item.sourceId);
					citations.set(key, { ...item, repository: source.name, ...git });
				}
				signal.throwIfAborted();
				const checked: InvestigationReport = { findings: [], uncertainties: input.uncertainties, truncated };
				for (const finding of input.findings) {
					checked.findings.push({ finding: finding.finding, evidence: finding.evidenceIds.map(key => citations.get(key)!) });
					if (Buffer.byteLength(JSON.stringify(checked)) > 12 * 1024) {
						checked.findings.pop(); checked.truncated = true;
						checked.uncertainties.push("Remaining findings exceeded the report output limit");
						break;
					}
				}
				report = checked;
				lastIssue = undefined;
				return { content: [{ type: "text", text: "Report accepted. Finish the investigation." }], details: {} };
			} catch (error) {
				lastIssue = (error as Error).message;
				throw error;
			}
		},
	};
	return {
		tools: [...tools, submit],
		getReport: () => report,
		getIssue: () => lastIssue,
		inspection: () => ({ inspectedSourceIds: [...inspected], readFailures: [...readFailures] }),
		wasTruncated: () => truncated,
		invalidate: () => { report = undefined; },
	};
}
