import { subagentProgressDetails } from "../../server/subagent-presentation.js";
import { subagentSteps } from "../../server/subagent-steps.js";
import type { UiSubagentProgress } from "../../server/protocol.js";

export interface SubagentCitationView {
	sourceId?: string;
	path: string;
	startLine: number;
	endLine: number;
	excerpt: string;
}

export interface SubagentFindingView {
	kind: "implementation" | "documentation" | "inference";
	statement: string;
	citations: SubagentCitationView[];
}

export interface SubagentReportView {
	summary: string;
	findings: SubagentFindingView[];
	connections: string[];
	openQuestions: string[];
	checkedAt: string;
}

export interface SubagentItemView extends UiSubagentProgress {
	text?: string;
	evidenceStatus?: "checked" | "unverified";
	evidenceWarning?: string;
	durationMs?: number;
	truncated?: boolean;
	outputTruncated?: boolean;
	omittedFindings?: number;
	omittedConnections?: number;
	omittedOpenQuestions?: number;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	report?: SubagentReportView;
}

export interface SubagentPresentation {
	workspace?: { id: string; name: string };
	items: SubagentItemView[];
	final: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function json(text: string): unknown {
	try { return JSON.parse(text); } catch { return undefined; }
}

function text(value: unknown): value is string {
	return typeof value === "string";
}

function number(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function progress(value: unknown): UiSubagentProgress | undefined {
	return subagentProgressDetails({ subagents: [value] })?.[0];
}

function report(value: unknown): SubagentReportView | undefined {
	const raw = object(value);
	if (!raw || !text(raw.summary) || !text(raw.checkedAt) || !Array.isArray(raw.findings) || !Array.isArray(raw.connections) || !Array.isArray(raw.openQuestions)) return;
	if (!raw.connections.every(text) || !raw.openQuestions.every(text)) return;
	const findings: SubagentFindingView[] = [];
	for (const value of raw.findings) {
		const finding = object(value);
		if (!finding || !["implementation", "documentation", "inference"].includes(String(finding.kind)) || !text(finding.statement) || !Array.isArray(finding.citations)) return;
		const citations: SubagentCitationView[] = [];
		for (const value of finding.citations) {
			const citation = object(value);
			if (!citation || !text(citation.path) || !number(citation.startLine) || !number(citation.endLine) || !text(citation.excerpt)) return;
			citations.push({ ...(text(citation.sourceId) ? { sourceId: citation.sourceId } : {}), path: citation.path, startLine: citation.startLine, endLine: citation.endLine, excerpt: citation.excerpt });
		}
		findings.push({ kind: finding.kind as SubagentFindingView["kind"], statement: finding.statement, citations });
	}
	return { summary: raw.summary, findings, connections: [...raw.connections], openQuestions: [...raw.openQuestions], checkedAt: raw.checkedAt };
}

function result(value: unknown): SubagentItemView | undefined {
	const raw = object(value);
	const base = raw ? progress({ ...raw, phase: raw.status }) : undefined;
	if (!base || !raw || !["completed", "failed", "cancelled"].includes(base.phase) || !text(raw.text) || !["checked", "unverified"].includes(String(raw.evidenceStatus))) return;
	const item: SubagentItemView = {
		...base,
		text: raw.text,
		evidenceStatus: raw.evidenceStatus as SubagentItemView["evidenceStatus"],
		...(text(raw.evidenceWarning) ? { evidenceWarning: raw.evidenceWarning } : {}),
		...(number(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
		...(raw.truncated === true ? { truncated: true } : {}),
		...(raw.outputTruncated === true ? { outputTruncated: true } : {}),
	};
	for (const key of ["omittedFindings", "omittedConnections", "omittedOpenQuestions"] as const) if (number(raw[key])) item[key] = raw[key];
	if (raw.usage !== undefined) {
		const usage = object(raw.usage);
		if (!usage || !number(usage.input) || !number(usage.output) || !number(usage.cacheRead) || !number(usage.cacheWrite) || !number(usage.cost)) return;
		item.usage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost };
	}
	if (raw.report !== undefined) {
		const parsed = report(raw.report);
		if (!parsed) return;
		item.report = parsed;
	}
	return item;
}

export function subagentPresentation(argumentsText: string, outputText: string, live?: UiSubagentProgress[], persisted?: UiSubagentProgress[]): SubagentPresentation | undefined {
	const args = object(json(argumentsText));
	if (!args || args.action !== "run" || (args.tasks !== undefined && !Array.isArray(args.tasks))) return;
	const tasks: UiSubagentProgress[] = [];
	for (const value of (Array.isArray(args.tasks) ? args.tasks : []).slice(0, 8)) {
		const task = object(value);
		if (!task || !text(task.task)) return;
		const ids = Array.isArray(task.sourceIds) ? task.sourceIds.filter(text) : text(task.sourceId) ? [task.sourceId] : [];
		if (!ids.length) return;
		tasks.push({ sourceId: ids[0], source: ids.join(", "), root: "", task: task.task, ...(text(task.title) ? { title: task.title } : {}), phase: "queued" });
	}
	const finalValue = object(json(outputText));
	let finalItems: SubagentItemView[] | undefined;
	let workspace: SubagentPresentation["workspace"];
	if (finalValue && Array.isArray(finalValue.results)) {
		finalItems = [];
		for (const value of finalValue.results.slice(0, 8)) {
			const parsed = result(value);
			if (!parsed) return;
			finalItems.push(parsed);
		}
		const group = object(finalValue.workspace);
		if (group && text(group.id) && text(group.name)) workspace = { id: group.id, name: group.name };
	}
	const liveItems = live?.slice(0, 8).map(progress).filter((item): item is UiSubagentProgress => !!item);
	const progressItems = liveItems?.length ? Array.from({ length: Math.max(tasks.length, liveItems.length) }, (_, index) => ({ ...tasks[index], ...liveItems[index] })) : tasks;
	const savedItems = persisted?.slice(0, 8).map(progress).filter((item): item is UiSubagentProgress => !!item);
	const items = finalItems?.map(item => {
		const savedIndex = savedItems?.findIndex(saved => item.taskId ? saved.taskId === item.taskId : saved.sourceId === item.sourceId) ?? -1;
		const saved = savedIndex >= 0 ? savedItems?.splice(savedIndex, 1)[0] : undefined;
		return saved ? { ...saved, ...item, steps: item.steps ?? saved.steps, tool: undefined } : item;
	}) ?? progressItems;
	if (!items.length) return;
	return { ...(workspace ? { workspace } : {}), items, final: finalItems !== undefined };
}

/** Parent results settle identity/status; detail enriches full instructions and uncropped output. */
export function mergeSubagentDetail(item: SubagentItemView, detail?: SubagentItemView, parentFinal = false): SubagentItemView {
	if (!detail) return item;
	const terminal = (value: SubagentItemView) => ["completed", "failed", "cancelled"].includes(value.phase);
	const winner = parentFinal || terminal(item) && !terminal(detail) || item.phase === "stopping" && ["queued", "running"].includes(detail.phase) ? item : detail;
	const merged = { ...item, ...detail, ...(parentFinal && detail.phase !== item.phase ? item : {}), task: detail.task, phase: winner.phase, durationMs: winner.durationMs, tool: terminal(winner) ? undefined : winner.tool };
	merged.steps = (winner.steps ?? merged.steps)?.map(step => {
		const other = (winner === item ? detail : item).steps?.find(value => value.id === step.id);
		return step.status === "running" && other && other.status !== "running" ? other : step;
	});
	return merged;
}
