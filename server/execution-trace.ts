import type { BackgroundCommand, BackgroundSpan } from "./protocol.js";
import { randomUUID } from "node:crypto";
import { TraceStore, type TraceStoreStatus } from "./trace-store.js";
import type { AgentSessionEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export type TraceStatus = "measured" | "unmeasured" | "ambiguous" | "not_triggered" | "failed" | "disabled";
export type Interval = { startMs: number; endMs: number };

export interface TraceMetric {
	value: number | null;
	status: TraceStatus;
	reason?: string;
}

export interface ProviderRequestTrace {
	requestId: string;
	runId?: string;
	turnIndex?: number;
	status: TraceStatus | "open";
	reasons: string[];
	provider?: string;
	api?: string;
	model?: string;
	hookStartMs?: number;
	normalizedStartMs?: number;
	firstHeadersMs?: number;
	firstProviderEventMs?: number;
	firstVisibleDeltaMs?: number;
	firstOutputKind?: string;
	messageEndMs?: number;
	responseAttempts: { atMs: number; status: number }[];
	responseAttemptsTruncated?: boolean;
	toolToProviderGapMs?: number;
}

export interface ToolExecutionTrace {
	toolCallId: string;
	parentToolCallId?: string;
	runId?: string;
	turnIndex?: number;
	toolName: string;
	startMs: number;
	endMs?: number;
	durationMs?: number;
	assistantToToolGapMs?: number;
	isError?: boolean;
	status: "open" | "measured" | "failed";
}

export interface HostSpan {
	kind: "onEvent" | "snapshot_build" | "ws_serialize" | "ws_send";
	startMs: number;
	endMs: number;
}

interface RunState {
	backgroundSpans?: BackgroundSpan[];
	runId: string;
	runSeq: number;
	bootId: string;
	processId: number;
	startedAt: string;
	sessionId: string;
	conversationId?: string;
	agentStartMs: number;
	agentSettledMs?: number;
	aborted?: boolean;
	currentTurnIndex?: number;
	lastAssistantEndMs?: number;
	lastToolEndMs?: number;
	requestIds: string[];
	toolCallIds: string[];
	hostSpans: HostSpan[];
	hostSpanOverflow?: HostSpanOverflow;
	requestsTruncated: boolean;
	toolsTruncated: boolean;
	storeSeq: number;
}

interface HostRequestState {
	hostRequestId: string;
	sessionId: string;
	conversationId: string;
	acceptedMs: number;
	disposition: "started" | "queued" | "handled";
	runId?: string;
	settledMs?: number;
	mappingStatus: TraceStatus | "open";
	reason?: string;
}

type AssistantMessage = Extract<AgentSessionEvent, { type: "message_start" }>["message"];

const MAX_RUNS_PER_SESSION = 50;
const MAX_HOST_SPANS_PER_RUN = 2048;
const MAX_REQUESTS_PER_RUN = 512;
const MAX_TOOLS_PER_RUN = 1024;
const MAX_RESPONSE_ATTEMPTS = 32;
const MAX_REASONS = 8;
const MAX_BACKGROUND_REQUESTS = 512;
const MAX_BACKGROUND_TOOLS = 256;
const MAX_HOST_REQUESTS = 256;

interface HostSpanOverflow {
	count: number;
	totalMs: number;
	maxMs: number;
	byKind: Record<string, { count: number; totalMs: number; maxMs: number }>;
}

const metric = (value: number | null, status: TraceStatus, reason?: string): TraceMetric => ({ value, status, ...(reason ? { reason } : {}) });
const finiteDuration = (end: number | undefined, start: number | undefined): number | null => end !== undefined && start !== undefined && end >= start ? end - start : null;

type TraceIssue = { status: "ambiguous" | "unmeasured"; reason: string };

function providerRequestIssue(requests: ProviderRequestTrace[], truncated: boolean): TraceIssue | undefined {
	if (truncated) return { status: "unmeasured", reason: "requests_truncated" };
	if (requests.some(request => request.status === "ambiguous")) return { status: "ambiguous", reason: "provider_requests_ambiguous" };
	if (requests.some(request => request.status !== "measured" || request.hookStartMs === undefined || request.messageEndMs === undefined)) return { status: "unmeasured", reason: "provider_requests_unmeasured" };
	return undefined;
}

export function unionIntervals(intervals: Interval[]): Interval[] {
	const sorted = intervals
		.filter(interval => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs) && interval.endMs > interval.startMs)
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	const result: Interval[] = [];
	for (const interval of sorted) {
		const previous = result.at(-1);
		if (previous && interval.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, interval.endMs);
		else result.push({ ...interval });
	}
	return result;
}

export function intervalDuration(intervals: Interval[]): number {
	return unionIntervals(intervals).reduce((total, interval) => total + interval.endMs - interval.startMs, 0);
}

function clipInterval(interval: Interval, root: Interval): Interval | null {
	const startMs = Math.max(interval.startMs, root.startMs);
	const endMs = Math.min(interval.endMs, root.endMs);
	return endMs > startMs ? { startMs, endMs } : null;
}

function intersectDuration(left: Interval[], right: Interval[]): number {
	let total = 0;
	for (const a of unionIntervals(left)) for (const b of unionIntervals(right)) {
		const clipped = clipInterval(a, b);
		if (clipped) total += clipped.endMs - clipped.startMs;
	}
	return total;
}

export class ExecutionTraceSession {
	readonly sessionId: string;
	private readonly now: () => number;
	private readonly bootId: string;
	private readonly onRunEvent?: (sessionId: string, runId: string, seq: number, type: string, payload: Record<string, unknown>) => void;
	private runSeq = 0;
	private requestSeq = 0;
	private backgroundSeq = 0;
	private currentRun?: RunState;
	private currentCompaction = false;
	private readonly runs: RunState[] = [];
	private readonly requests = new Map<string, ProviderRequestTrace>();
	private readonly tools = new Map<string, ToolExecutionTrace>();
	private readonly hostRequests = new Map<string, HostRequestState>();
	private readonly messages = new WeakMap<object, ProviderRequestTrace>();
	private readonly messagesByTimestamp = new Map<number, ProviderRequestTrace>();
	private readonly backgroundRequestIds: string[] = [];
	private readonly backgroundToolIds: string[] = [];

	constructor(
		sessionId: string,
		now: () => number = () => performance.now(),
		bootId = randomUUID(),
		onRunEvent?: (sessionId: string, runId: string, seq: number, type: string, payload: Record<string, unknown>) => void,
	) {
		this.sessionId = sessionId;
		this.now = now;
		this.bootId = bootId;
		this.onRunEvent = onRunEvent;
	}

	promptAccepted(conversationId: string, hostRequestId: string, disposition: "started" | "queued" | "handled"): void {
		if (this.hostRequests.has(hostRequestId)) return;
		const request: HostRequestState = {
			hostRequestId, sessionId: this.sessionId, conversationId, acceptedMs: this.now(), disposition,
			mappingStatus: disposition === "handled" ? "not_triggered" : "open",
		};
		if (disposition === "handled") request.settledMs = request.acceptedMs;
		this.hostRequests.set(hostRequestId, request);
		while (this.hostRequests.size > MAX_HOST_REQUESTS) {
			const oldest = this.hostRequests.keys().next().value;
			if (!oldest) break;
			this.hostRequests.delete(oldest);
		}
	}

	beforeProviderRequest(): void {
		const at = this.now();
		const run = this.currentRun;
		if (run && run.requestIds.length >= MAX_REQUESTS_PER_RUN) {
			run.requestsTruncated = true;
			for (const request of this.openRequests(run)) this.markRequest(request, "ambiguous", "requests_truncated");
			return;
		}
		const requestId = run ? `${run.runId}:request-${++this.requestSeq}` : `${this.sessionId}:background-${++this.backgroundSeq}`;
		const unresolved = run ? this.openRequests(run).filter(request => request.hookStartMs !== undefined) : [];
		const request: ProviderRequestTrace = {
			requestId,
			...(run ? { runId: run.runId, turnIndex: this.currentCompaction ? undefined : run.currentTurnIndex } : {}),
			status: run ? unresolved.length ? "ambiguous" : "open" : "unmeasured",
			reasons: run ? unresolved.length ? ["overlapping_provider_requests"] : [] : ["no_active_agent_run"],
			hookStartMs: at,
			responseAttempts: [],
		};
		for (const previous of unresolved) this.markRequest(previous, "ambiguous", "overlapping_provider_requests");
		if (run) {
			run.requestIds.push(requestId);
			if (run.lastToolEndMs !== undefined) {
				request.toolToProviderGapMs = Math.max(0, at - run.lastToolEndMs);
				run.lastToolEndMs = undefined;
			}
		}
		this.requests.set(requestId, request);
		if (!run) this.retainBackground(this.backgroundRequestIds, this.requests, requestId, MAX_BACKGROUND_REQUESTS);
	}

	afterProviderResponse(status: number): void {
		const at = this.now();
		const candidates = this.openProviderCandidates();
		if (candidates.length !== 1) {
			for (const request of candidates) this.markRequest(request, "ambiguous", "ambiguous_response_owner");
			return;
		}
		const request = candidates[0];
		if (request.messageEndMs !== undefined || request.hookStartMs === undefined) {
			this.markRequest(request, "ambiguous", "invalid_response_order");
			return;
		}
		if (request.responseAttempts.length < MAX_RESPONSE_ATTEMPTS) request.responseAttempts.push({ atMs: at, status });
		else request.responseAttemptsTruncated = true;
		request.firstHeadersMs ??= at;
	}

	providerStreamEvent(provider: string, api: string, model: string): void {
		const at = this.now();
		const candidates = this.openProviderCandidates();
		if (candidates.length !== 1) {
			for (const request of candidates) this.markRequest(request, "ambiguous", "ambiguous_stream_owner");
			return;
		}
		const request = candidates[0];
		if (request.hookStartMs === undefined || request.messageEndMs !== undefined) {
			this.markRequest(request, "ambiguous", "invalid_stream_order");
			return;
		}
		if ((request.provider && request.provider !== provider) || (request.api && request.api !== api) || (request.model && request.model !== model)) {
			this.markRequest(request, "ambiguous", "provider_identity_changed");
			return;
		}
		request.provider = provider;
		request.api = api;
		request.model = model;
		request.firstProviderEventMs ??= at;
	}

	backgroundCommand(view: BackgroundCommand) {
		const run = this.runs.findLast(r => r.toolCallIds.includes(view.id));
		if (!run) return;
		const spans = run.backgroundSpans ??= [];
		let span = spans.find(s => s.id === view.id);
		if (!span) spans.push(span = { id: view.id, startMs: this.now(), state: view.state });
		span.state = view.state;
		if (view.endedAt) span.endMs = this.now();
		this.emitRunEvent(run, "background_command", { backgroundSpans: spans.map(s => ({ ...s })) });
	}
	observe(event: AgentSessionEvent, conversationId?: string): void {
		const at = this.now();
		switch (event.type) {
			case "agent_start": {
				if (this.currentRun && this.currentRun.agentSettledMs === undefined) this.closeRun(this.currentRun, at, "ambiguous");
				const runSeq = ++this.runSeq;
				const runId = randomUUID();
				const run: RunState = {
					runId, runSeq, bootId: this.bootId, processId: process.pid, startedAt: new Date().toISOString(),
					sessionId: this.sessionId, conversationId, agentStartMs: at, requestIds: [], toolCallIds: [], hostSpans: [],
					requestsTruncated: false, toolsTruncated: false, storeSeq: 0,
				};
				this.runs.push(run);
				this.pruneRuns();
				this.currentRun = run;
				this.mapHostRequests(run);
				this.emitRunEvent(run, "run_start", { run: this.runMetadata(run) });
				break;
			}
			case "turn_start":
				if (this.currentRun) {
					const value = (event as unknown as { turnIndex?: unknown }).turnIndex;
					this.currentRun.currentTurnIndex = typeof value === "number" ? value : (this.currentRun.currentTurnIndex ?? -1) + 1;
				}
				break;
			case "message_start":
				if (event.message.role === "assistant") this.startAssistant(event.message, at);
				break;
			case "message_update": {
				const request = this.requestForMessage(event.message as AssistantMessage);
				if (request && request.firstVisibleDeltaMs === undefined) {
					const update = event.assistantMessageEvent;
					if (("delta" in update && typeof update.delta === "string" && update.delta.length > 0) || update.type === "toolcall_start") {
						request.firstVisibleDeltaMs = at;
						request.firstOutputKind = update.type;
					}
				}
				break;
			}
			case "message_end":
				if (event.message.role === "assistant") this.endAssistant(event.message, at);
				break;
			case "tool_execution_start": {
				const run = this.currentRun;
				if (run && run.toolCallIds.length >= MAX_TOOLS_PER_RUN) {
					run.toolsTruncated = true;
					break;
				}
				const tool: ToolExecutionTrace = {
					toolCallId: event.toolCallId,
					...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
					...(run ? { runId: run.runId, turnIndex: run.currentTurnIndex } : {}),
					toolName: event.toolName,
					startMs: at,
					...(run?.lastAssistantEndMs !== undefined ? { assistantToToolGapMs: Math.max(0, at - run.lastAssistantEndMs) } : {}),
					status: "open",
				};
				this.tools.set(event.toolCallId, tool);
				run?.toolCallIds.push(event.toolCallId);
				if (!run) this.retainBackground(this.backgroundToolIds, this.tools, event.toolCallId, MAX_BACKGROUND_TOOLS);
				break;
			}
			case "tool_execution_end": {
				const tool = this.tools.get(event.toolCallId);
				if (!tool) break;
				tool.endMs = at;
				tool.durationMs = event.durationMs;
				tool.isError = event.isError;
				tool.status = event.isError ? "failed" : "measured";
				const run = this.currentRun;
				if (run) run.lastToolEndMs = Math.max(run.lastToolEndMs ?? at, at);
				const owner = tool.runId ? this.runs.find(candidate => candidate.runId === tool.runId) : undefined;
				if (owner) this.emitRunEvent(owner, "tool_end", { tool: { ...tool } });
				break;
			}
			case "compaction_start":
				this.currentCompaction = true;
				break;
			case "compaction_end":
				this.currentCompaction = false;
				break;
			case "agent_settled": {
				const run = this.currentRun;
				if (run) {
					run.aborted = event.aborted;
					this.closeRun(run, at, event.aborted ? "failed" : "measured");
				}
				break;
			}
		}
	}

	measureHost(kind: HostSpan["kind"], startMs: number): void {
		const run = this.currentRun;
		if (!run || run.agentSettledMs !== undefined) return;
		const endMs = this.now();
		if (endMs < startMs) return;
		const span = { kind, startMs, endMs };
		if (run.hostSpans.length < MAX_HOST_SPANS_PER_RUN) {
			run.hostSpans.push(span);
			return;
		}
		const duration = endMs - startMs;
		const overflow = run.hostSpanOverflow ??= { count: 0, totalMs: 0, maxMs: 0, byKind: {} };
		overflow.count += 1;
		overflow.totalMs += duration;
		overflow.maxMs = Math.max(overflow.maxMs, duration);
		const kindTotal = overflow.byKind[kind] ??= { count: 0, totalMs: 0, maxMs: 0 };
		kindTotal.count += 1;
		kindTotal.totalMs += duration;
		kindTotal.maxMs = Math.max(kindTotal.maxMs, duration);
	}

	report(): Record<string, unknown> {
		const requests = [...this.requests.values()];
		const matched = requests.filter(request => request.status === "measured").length;
		const ambiguous = requests.filter(request => request.status === "ambiguous").length;
		const unmeasured = requests.filter(request => request.status === "unmeasured").length;
		return {
			schemaVersion: 1,
			sessionId: this.sessionId,
			runs: this.runs.map(run => this.reportRun(run)),
			hostRequests: [...this.hostRequests.values()].map(request => this.reportHostRequest(request)),
			coverage: {
				provider_requests_total: requests.length,
				provider_requests_matched: matched,
				provider_requests_ambiguous: ambiguous,
				provider_requests_unmeasured: unmeasured,
				trace_coverage: requests.length ? matched / requests.length : null,
				scope: "identified_requests_only",
			},
		};
	}

	private runMetadata(run: RunState): Record<string, unknown> {
		return {
			runId: run.runId, runSeq: run.runSeq, bootId: run.bootId, processId: run.processId,
			startedAt: run.startedAt, sessionId: run.sessionId, conversationId: run.conversationId,
			agentStartMs: run.agentStartMs,
		};
	}

	private emitRunEvent(run: RunState, type: string, payload: Record<string, unknown>): void {
		this.onRunEvent?.(this.sessionId, run.runId, ++run.storeSeq, type, payload);
	}

	private pruneRuns(): void {
		while (this.runs.length > MAX_RUNS_PER_SESSION) {
			const index = this.runs.findIndex(run => run !== this.currentRun);
			if (index < 0) break;
			const [removed] = this.runs.splice(index, 1);
			for (const id of removed.requestIds) this.requests.delete(id);
			for (const id of removed.toolCallIds) this.tools.delete(id);
			for (const [id, request] of this.hostRequests) if (request.runId === removed.runId) this.hostRequests.delete(id);
		}
	}

	private retainBackground<T>(ids: string[], values: Map<string, T>, id: string, limit: number): void {
		ids.push(id);
		while (ids.length > limit) {
			const oldest = ids.shift();
			if (oldest) values.delete(oldest);
		}
	}

	private openRequests(run: RunState): ProviderRequestTrace[] {
		return run.requestIds.map(id => this.requests.get(id)).filter((request): request is ProviderRequestTrace => !!request && request.messageEndMs === undefined);
	}

	private openProviderCandidates(): ProviderRequestTrace[] {
		return [...this.requests.values()].filter(request => request.hookStartMs !== undefined && request.messageEndMs === undefined && !["ambiguous", "unmeasured"].includes(request.status));
	}

	private markRequest(request: ProviderRequestTrace, status: "ambiguous" | "unmeasured", reason: string): void {
		request.status = status;
		if (!request.reasons.includes(reason) && request.reasons.length < MAX_REASONS) request.reasons.push(reason);
	}

	private startAssistant(message: AssistantMessage, at: number): void {
		const run = this.currentRun;
		if (run?.requestsTruncated) return;
		const candidates = run ? this.openRequests(run).filter(request => request.status === "open") : [];
		if (candidates.length > 1) {
			for (const request of candidates) this.markRequest(request, "ambiguous", "ambiguous_assistant_owner");
		}
		let request = candidates.length === 1 ? candidates[0] : undefined;
		if (!request && run && run.requestIds.length >= MAX_REQUESTS_PER_RUN) {
			run.requestsTruncated = true;
			return;
		}
		if (!request) {
			const requestId = run ? `${run.runId}:request-${++this.requestSeq}` : `${this.sessionId}:background-${++this.backgroundSeq}`;
			request = {
				requestId,
				...(run ? { runId: run.runId, turnIndex: run.currentTurnIndex } : {}),
				status: candidates.length > 1 ? "ambiguous" : "unmeasured",
				reasons: [candidates.length > 1 ? "ambiguous_assistant_owner" : "missing_before_provider_request"],
				normalizedStartMs: at,
				responseAttempts: [],
			};
			this.requests.set(requestId, request);
			run?.requestIds.push(requestId);
			if (!run) this.retainBackground(this.backgroundRequestIds, this.requests, requestId, MAX_BACKGROUND_REQUESTS);
		}
		request.normalizedStartMs ??= at;
		this.messages.set(message as object, request);
		if (typeof message.timestamp === "number") {
			const previous = this.messagesByTimestamp.get(message.timestamp);
			if (previous && previous !== request && previous.messageEndMs === undefined) {
				this.markRequest(previous, "ambiguous", "duplicate_assistant_timestamp");
				this.markRequest(request, "ambiguous", "duplicate_assistant_timestamp");
			}
			this.messagesByTimestamp.set(message.timestamp, request);
		}
	}

	private requestForMessage(message: AssistantMessage): ProviderRequestTrace | undefined {
		return this.messages.get(message as object) ?? (typeof message.timestamp === "number" ? this.messagesByTimestamp.get(message.timestamp) : undefined);
	}

	private endAssistant(message: AssistantMessage, at: number): void {
		const request = this.requestForMessage(message);
		if (request) {
			request.messageEndMs = at;
			if (request.status === "open") request.status = "measured";
			if (typeof message.timestamp === "number" && this.messagesByTimestamp.get(message.timestamp) === request) this.messagesByTimestamp.delete(message.timestamp);
			const owner = request.runId ? this.runs.find(run => run.runId === request.runId) : undefined;
			if (owner) this.emitRunEvent(owner, "provider_request", { request: this.reportRequest(request) });
		}
		const run = this.currentRun;
		if (run) run.lastAssistantEndMs = at;
	}

	private mapHostRequests(run: RunState): void {
		const candidates = [...this.hostRequests.values()].filter(request => request.sessionId === run.sessionId && request.mappingStatus === "open");
		const direct = candidates.filter(request => request.disposition === "started");
		if (direct.length === 1 && candidates.length === 1) {
			direct[0].runId = run.runId;
			direct[0].mappingStatus = "measured";
			run.conversationId = direct[0].conversationId;
			return;
		}
		for (const request of candidates) {
			request.mappingStatus = "ambiguous";
			request.reason = direct.length ? "multiple_prompt_candidates" : "queued_prompt_run_mapping_not_verified";
		}
	}

	private closeRun(run: RunState, at: number, status: TraceStatus): void {
		run.agentSettledMs ??= at;
		for (const request of this.hostRequests.values()) if (request.runId === run.runId) {
			request.settledMs ??= at;
			if (status === "failed") request.mappingStatus = "failed";
		}
		for (const request of this.openRequests(run)) {
			if (request.status === "open") this.markRequest(request, "unmeasured", "run_settled_before_message_end");
			else if (request.status === "ambiguous" && !request.reasons.includes("run_settled_before_message_end") && request.reasons.length < MAX_REASONS) request.reasons.push("run_settled_before_message_end");
		}
		for (const id of run.toolCallIds) {
			const tool = this.tools.get(id);
			if (tool?.status === "open") tool.status = "failed";
		}
		if (this.currentRun === run) this.currentRun = undefined;
		this.emitRunEvent(run, "run_settled", { run: this.reportRun(run) });
	}

	private reportRun(run: RunState): Record<string, unknown> {
		const requests = run.requestIds.map(id => this.requests.get(id)).filter((request): request is ProviderRequestTrace => !!request).map(request => this.reportRequest(request));
		const tools = run.toolCallIds.map(id => this.tools.get(id)).filter((tool): tool is ToolExecutionTrace => !!tool);
		const root = run.agentSettledMs !== undefined ? { startMs: run.agentStartMs, endMs: run.agentSettledMs } : null;
		const modelIntervals = root ? requests.flatMap(request => {
			if (request.status !== "measured" || request.hookStartMs === undefined || request.messageEndMs === undefined) return [];
			const clipped = clipInterval({ startMs: request.hookStartMs, endMs: request.messageEndMs }, root);
			return clipped ? [clipped] : [];
		}) : [];
		const toolIntervals = root ? tools.flatMap(tool => {
			if (tool.parentToolCallId || tool.endMs === undefined) return [];
			const clipped = clipInterval({ startMs: tool.startMs, endMs: tool.endMs }, root);
			return clipped ? [clipped] : [];
		}) : [];
		const hostIntervals = root ? run.hostSpans.flatMap(span => {
			const clipped = clipInterval(span, root);
			return clipped ? [clipped] : [];
		}) : [];
		const combined = unionIntervals([...modelIntervals, ...toolIntervals, ...hostIntervals]);
		const hostExact = !!root && !run.hostSpanOverflow;
		const modelIssue = providerRequestIssue(requests, run.requestsTruncated);
		const modelExact = !!root && !modelIssue;
		const toolIssue = run.toolsTruncated ? "tools_truncated" : tools.some(tool => !tool.parentToolCallId && tool.endMs === undefined) ? "tool_end_missing" : undefined;
		const toolExact = !!root && !toolIssue;
		const allExact = hostExact && modelExact && toolExact;
		const aggregateIssue: TraceIssue | undefined = run.hostSpanOverflow
			? { status: "unmeasured", reason: "host_spans_truncated" }
			: modelIssue ?? (toolIssue ? { status: "unmeasured", reason: toolIssue } : undefined);
		return {
			...this.runMetadata(run),
			agentSettledMs: run.agentSettledMs,
			aborted: run.aborted,
			status: run.agentSettledMs === undefined ? "open" : run.aborted ? "failed" : "measured",
			requests,
			tools,
			hostSpans: run.hostSpans,
			backgroundSpans: run.backgroundSpans?.map(span => ({ ...span, observedMs: span.endMs ?? this.now() })),
			hostSpanOverflow: run.hostSpanOverflow,
			requestsTruncated: run.requestsTruncated,
			toolsTruncated: run.toolsTruncated,
			aggregates: {
				agent_active_wall_ms: metric(finiteDuration(run.agentSettledMs, run.agentStartMs), root ? "measured" : "unmeasured"),
				model_wall_union_ms: modelExact ? metric(intervalDuration(modelIntervals), "measured") : metric(null, modelIssue?.status ?? "unmeasured", modelIssue?.reason ?? "run_open"),
				model_observed_lower_bound_ms: metric(intervalDuration(modelIntervals), root ? "measured" : "unmeasured"),
				tool_wall_union_ms: toolExact ? metric(intervalDuration(toolIntervals), "measured") : metric(null, "unmeasured", toolIssue ?? "run_open"),
				tool_observed_lower_bound_ms: metric(intervalDuration(toolIntervals), root ? "measured" : "unmeasured"),
				host_wall_union_ms: hostExact ? metric(intervalDuration(hostIntervals), "measured") : metric(null, "unmeasured", run.hostSpanOverflow ? "host_spans_truncated" : "run_open"),
				host_observed_lower_bound_ms: metric(intervalDuration(hostIntervals), root ? "measured" : "unmeasured"),
				host_inside_model_ms: allExact ? metric(intersectDuration(hostIntervals, modelIntervals), "measured") : metric(null, aggregateIssue?.status ?? "unmeasured", aggregateIssue?.reason ?? "run_open"),
				host_inside_tool_ms: allExact ? metric(intersectDuration(hostIntervals, toolIntervals), "measured") : metric(null, aggregateIssue?.status ?? "unmeasured", aggregateIssue?.reason ?? "run_open"),
				host_outside_model_tool_ms: allExact ? metric(intervalDuration(hostIntervals) - intersectDuration(hostIntervals, [...modelIntervals, ...toolIntervals]), "measured") : metric(null, aggregateIssue?.status ?? "unmeasured", aggregateIssue?.reason ?? "run_open"),
				unclassified_wall_ms: allExact && root ? metric(Math.max(0, root.endMs - root.startMs - intervalDuration(combined)), "measured") : metric(null, aggregateIssue?.status ?? "unmeasured", aggregateIssue?.reason ?? "run_open"),
				host_process_cpu_time_ms: metric(null, "unmeasured", "process_cpu_not_isolated"),
			},
		};
	}

	private reportRequest(request: ProviderRequestTrace): ProviderRequestTrace & { metrics: Record<string, TraceMetric> } {
		return {
			...request,
			reasons: [...request.reasons],
			responseAttempts: [...request.responseAttempts],
			metrics: {
				provider_hook_to_headers_ms: metric(finiteDuration(request.firstHeadersMs, request.hookStartMs), request.firstHeadersMs !== undefined && request.hookStartMs !== undefined ? "measured" : "unmeasured"),
				headers_to_first_provider_event_ms: metric(finiteDuration(request.firstProviderEventMs, request.firstHeadersMs), request.firstProviderEventMs !== undefined && request.firstHeadersMs !== undefined ? "measured" : "unmeasured"),
				first_event_to_first_visible_delta_ms: metric(finiteDuration(request.firstVisibleDeltaMs, request.firstProviderEventMs), request.firstVisibleDeltaMs !== undefined && request.firstProviderEventMs !== undefined ? "measured" : "unmeasured"),
				provider_hook_to_message_end_ms: metric(finiteDuration(request.messageEndMs, request.hookStartMs), request.messageEndMs !== undefined && request.hookStartMs !== undefined && request.status === "measured" ? "measured" : request.status === "ambiguous" ? "ambiguous" : "unmeasured"),
				tool_to_provider_gap_ms: metric(request.toolToProviderGapMs ?? null, request.toolToProviderGapMs !== undefined ? "measured" : "not_triggered"),
			},
		};
	}

	private reportHostRequest(request: HostRequestState): Record<string, unknown> {
		const run = request.runId ? this.runs.find(candidate => candidate.runId === request.runId) : undefined;
		const end = request.settledMs;
		const root = end !== undefined ? { startMs: request.acceptedMs, endMs: end } : null;
		let unclassified: TraceMetric = metric(null, request.mappingStatus === "ambiguous" ? "ambiguous" : "unmeasured");
		if (root && run && request.mappingStatus === "measured" && !run.hostSpanOverflow && !run.toolsTruncated) {
			const requests = run.requestIds.map(id => this.requests.get(id)).filter((value): value is ProviderRequestTrace => !!value);
			const modelIssue = providerRequestIssue(requests, run.requestsTruncated);
			const tools = run.toolCallIds.map(id => this.tools.get(id)).filter((value): value is ToolExecutionTrace => !!value);
			const intervals: Interval[] = [];
			if (run.agentStartMs > request.acceptedMs) intervals.push({ startMs: request.acceptedMs, endMs: Math.min(run.agentStartMs, root.endMs) });
			for (const provider of requests) if (provider.status === "measured" && provider.hookStartMs !== undefined && provider.messageEndMs !== undefined) {
				const clipped = clipInterval({ startMs: provider.hookStartMs, endMs: provider.messageEndMs }, root);
				if (clipped) intervals.push(clipped);
			}
			for (const tool of tools) if (!tool.parentToolCallId && tool.endMs !== undefined) {
				const clipped = clipInterval({ startMs: tool.startMs, endMs: tool.endMs }, root);
				if (clipped) intervals.push(clipped);
			}
			for (const span of run.hostSpans) {
				const clipped = clipInterval(span, root);
				if (clipped) intervals.push(clipped);
			}
			unclassified = tools.some(tool => !tool.parentToolCallId && tool.endMs === undefined) ? metric(null, "unmeasured", "tool_end_missing") : modelIssue ? metric(null, modelIssue.status, modelIssue.reason) : metric(Math.max(0, root.endMs - root.startMs - intervalDuration(intervals)), "measured");
		}
		return {
			...request,
			metrics: {
				task_e2e_wall_ms: metric(finiteDuration(end, request.acceptedMs), end !== undefined && request.mappingStatus === "measured" ? "measured" : request.mappingStatus === "ambiguous" ? "ambiguous" : "unmeasured"),
				agent_active_wall_ms: metric(finiteDuration(run?.agentSettledMs, run?.agentStartMs), run?.agentSettledMs !== undefined && request.mappingStatus === "measured" ? "measured" : request.mappingStatus === "ambiguous" ? "ambiguous" : "unmeasured"),
				queue_wait_ms: metric(finiteDuration(run?.agentStartMs, request.acceptedMs), run && request.disposition === "started" && request.mappingStatus === "measured" ? "measured" : request.mappingStatus === "ambiguous" ? "ambiguous" : "unmeasured"),
				unclassified_wall_ms: unclassified,
			},
		};
	}
}

export class ExecutionTraceRegistry {
	readonly enabled = !["0", "off", "false"].includes((process.env.PI_TASK_TIMINGS ?? "").toLowerCase());
	readonly bootId = randomUUID();
	private readonly sessions = new Map<string, ExecutionTraceSession>();
	private readonly store?: TraceStore;
	private static readonly MAX_SESSIONS = 32;

	constructor(directory?: string, onDegraded?: (error: string) => void) {
		if (directory) this.store = new TraceStore(directory, { onDegraded });
	}

	forSession(sessionId: string): ExecutionTraceSession | undefined {
		if (!this.enabled) return undefined;
		let trace = this.sessions.get(sessionId);
		if (trace) {
			this.sessions.delete(sessionId);
			this.sessions.set(sessionId, trace);
			return trace;
		}
		trace = new ExecutionTraceSession(sessionId, () => performance.now(), this.bootId, (session, runId, seq, type, payload) => {
			this.store?.append({ schemaVersion: 1, sessionId: session, runId, seq, type: type as "background_command" | "run_start" | "provider_request" | "tool_end" | "run_settled", recordedAt: new Date().toISOString(), payload });
		});
		this.sessions.set(sessionId, trace);
		if (this.sessions.size > ExecutionTraceRegistry.MAX_SESSIONS) {
			const oldest = this.sessions.keys().next().value;
			if (oldest) this.sessions.delete(oldest);
		}
		return trace;
	}

	promptAccepted(sessionId: string, conversationId: string, hostRequestId: string, disposition: "started" | "queued" | "handled"): void {
		this.forSession(sessionId)?.promptAccepted(conversationId, hostRequestId, disposition);
	}

	measureHost(sessionId: string, kind: HostSpan["kind"], startMs: number): void {
		this.sessions.get(sessionId)?.measureHost(kind, startMs);
	}

	persistenceStatus(): TraceStoreStatus {
		return this.store?.getStatus() ?? { state: "ready" };
	}

	reportSession(sessionId: string, conversationId?: string): Record<string, unknown> {
		const live = this.sessions.get(sessionId)?.report() as { runs?: Record<string, unknown>[]; hostRequests?: Record<string, unknown>[]; coverage?: Record<string, unknown> } | undefined;
		const persisted = this.store?.readSession(sessionId).runs ?? [];
		const runsById = new Map<string, Record<string, unknown>>();
		for (const run of persisted) if (typeof run.runId === "string") runsById.set(run.runId, run);
		for (const run of live?.runs ?? []) if (typeof run.runId === "string") runsById.set(run.runId, run);
		const matches = (run: Record<string, unknown>) => !conversationId || run.conversationId === conversationId;
		const runs = [...runsById.values()].filter(matches).sort((a, b) => Number(a.agentStartMs ?? 0) - Number(b.agentStartMs ?? 0));
		return {
			schemaVersion: 1,
			sessionId,
			runs,
			hostRequests: (live?.hostRequests ?? []).filter(request => matches({ conversationId: request.conversationId })),
			coverage: live?.coverage ?? { provider_requests_total: 0, provider_requests_matched: 0, trace_coverage: null, scope: "identified_requests_only" },
			persistence: this.persistenceStatus(),
			privacy: { containsMessageContent: false, anonymous: false, notice: "Metadata-only trace; identifiers and timing are not anonymized." },
		};
	}

	report(): Record<string, unknown> | null {
		if (!this.enabled) return null;
		return { sessions: Object.fromEntries([...this.sessions].map(([id, trace]) => [id, trace.report()])), persistence: this.persistenceStatus() };
	}
}

export function createExecutionTraceExtension(trace: ExecutionTraceSession): ExtensionFactory {
	return pi => {
		pi.on("before_provider_request", () => { trace.beforeProviderRequest(); });
		pi.on("after_provider_response", event => { trace.afterProviderResponse(event.status); });
		pi.on("provider_stream_event", event => { trace.providerStreamEvent(event.provider, event.api, event.model); });
		const observe = (event: unknown) => trace.observe(event as AgentSessionEvent);
		pi.on("turn_start", observe);
		pi.on("message_start", observe);
		pi.on("message_update", observe);
		pi.on("message_end", observe);
		pi.on("tool_execution_start", observe);
		pi.on("tool_execution_end", observe);
		pi.on("agent_settled", observe);
	};
}
