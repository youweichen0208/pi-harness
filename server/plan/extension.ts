import { Type } from "typebox";
import type { ExtensionFactory, ContextEvent, SessionEntry, AgentBeforeSettleEvent } from "@earendil-works/pi-coding-agent";
import { PLAN_REMINDER_TYPE, editableState, latestPlan, snapshotFromDetails, transition } from "./state.js";
import { TOOL_TEXT_CONTINUE_PROMPT } from "../tool-text.js";

const string = (maxLength: number) => Type.String({ minLength: 1, maxLength });
export const planParameters = Type.Object({
	action: Type.Union([Type.Literal("create"), Type.Literal("update")]),
	planId: Type.Optional(string(128)), expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
	title: string(80), status: Type.Union([Type.Literal("active"), Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("failed")]),
	steps: Type.Array(Type.Object({ id: string(64), title: string(80), detail: Type.Optional(string(500)) }), { minItems: 1, maxItems: 16, description: "Required for BOTH create and update, including completion. Send every step with its id, title and detail; never omit unchanged steps." }),
	currentStepId: Type.Union([string(64), Type.Null()], { description: "Current step for active plans; terminal statuses clear it automatically." }), completedStepIds: Type.Array(string(64), { maxItems: 16, uniqueItems: true, description: "Completed step IDs. Explicit status completed completes all submitted steps; cancelled/failed preserve this list." }),
	completionCriteria: string(240), changeSummary: Type.Optional(string(240)),
});

export function restorePlanContext(messages: ContextEvent["messages"], branch: readonly SessionEntry[]): ContextEvent["messages"] {
	const latest = latestPlan(branch);
	if (!latest || latest.snapshot.status !== "active") return messages;
	const { snapshot, toolCallId } = latest;
	const visibleResult = messages.some(message => message.role === "toolResult" && message.toolName === "plan" && message.toolCallId === toolCallId && !message.isError && JSON.stringify(snapshotFromDetails(message.details)) === JSON.stringify(snapshot));
	const visibleCall = messages.some(message => message.role === "assistant" && message.content.some(block => {
		if (block.type !== "toolCall" || block.name !== "plan" || block.id !== toolCallId) return false;
		try {
			const args = block.arguments;
			const identity = args.action === "create" ? snapshot.revision === 1 : args.action === "update" && args.planId === snapshot.planId && args.expectedRevision === snapshot.revision - 1;
			return identity && JSON.stringify(editableState(args)) === JSON.stringify(editableState(snapshot));
		} catch { return false; }
	}));
	const lastUser = messages.findLastIndex(message => message.role === "user");
	const lastPlanResult = messages.slice(lastUser + 1).findLast(message => message.role === "toolResult" && message.toolName === "plan");
	const failedCall = lastPlanResult?.role === "toolResult" && lastPlanResult.isError;
	if (visibleResult && visibleCall && !failedCall) return messages;
	const content = `${failedCall ? "Plan call failed; the saved plan below is unchanged. To correct the call, submit the full state including steps, even if unchanged or marking completion. Use the saved planId and expectedRevision. This reminder does not authorize continuing work.\n" : ""}Historical plan background, not authorization to continue. Judge relevance to the current request yourself. For related, already authorized implementation, update this plan with its current identity and revision and continue without requesting separate plan approval. For unrelated multi-step work, create a new plan. Ordinary questions do not require a plan. Follow user/skill instructions and waiting requirements; this tool grants no extra permissions.\n${JSON.stringify({ action: "update", planId: snapshot.planId, expectedRevision: snapshot.revision, ...editableState(snapshot) })}`;
	const reminder: ContextEvent["messages"][number] = { role: "custom", customType: "pi-harness:plan-background", content, display: false, timestamp: 0 };
	const summary = messages.findLastIndex(message => message.role === "compactionSummary");
	const user = messages.findLastIndex(message => message.role === "user");
	let at = summary >= 0 ? summary + 1 : user >= 0 ? user : 0;
	// A user interruption may occur inside an outstanding call/result group.
	// Keep that entire group together when selecting the insertion boundary.
	const open = new Map<string, number>();
	for (let index = 0; index < at; index++) {
		const message = messages[index];
		if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") open.set(block.id, index);
		if (message.role === "toolResult") open.delete(message.toolCallId);
	}
	if (open.size) at = Math.min(at, ...open.values());
	return [...messages.slice(0, at), reminder, ...messages.slice(at)];
}

/** Settle reminders: at most one per plan per user request, so a model that
 *  keeps answering without closing the plan cannot loop the boundary. */
const reminded = new WeakMap<object, Map<string, string>>();

/** The plan looks finished but the model never closed it: every step except
 *  the current one is completed, and the current one has calls attributed in
 *  this user request — after this request's plan call — that all have
 *  results (issue #63). Earlier requests never count, so an unfinished plan
 *  does not trigger a reminder on every later message. */
function planLooksConcluded(event: AgentBeforeSettleEvent, latest: NonNullable<ReturnType<typeof latestPlan>>): boolean {
	const { snapshot } = latest;
	const pending = snapshot.steps.filter(step => !snapshot.completedStepIds.includes(step.id) && step.id !== snapshot.currentStepId);
	if (pending.length) return false;
	const messages = event.context.contextMessages;
	const start = messages.findLastIndex(message => message.role === "user" && userText(message.content) !== TOOL_TEXT_CONTINUE_PROMPT);
	const turn = messages.slice(start + 1);
	const results = new Set(turn.filter(message => message.role === "toolResult").map(message => message.toolCallId));
	let attributed = 0, seen = false;
	for (const message of turn) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (block.name === "plan") { seen = block.id === latest.toolCallId; continue; }
			if (!seen) continue;
			attributed++;
			if (!results.has(block.id)) return false; // step work still in flight
		}
	}
	return attributed > 0 || (seen && !snapshot.currentStepId); // all steps completed, only the status was left active
}

const userText = (content: string | readonly { type: string; text?: string }[]): string => typeof content === "string" ? content : content.map(block => block.type === "text" ? block.text ?? "" : "").join("");

export const createPlanExtension = (): ExtensionFactory => pi => {
	pi.registerTool({
		name: "plan", label: "Plan", description: "Create or update a complete, versioned implementation plan on this session branch. Every call requires title, status, steps, currentStepId, completedStepIds and completionCriteria, even when completing or only changing status. Updates also require the latest planId and expectedRevision. This is full replacement, not a partial patch. Explicit completed status completes all submitted steps and clears currentStepId; cancelled/failed only clear currentStepId. Ended plans require create.",
		exposure: "model-only", executionMode: "sequential", defaultActive: false,
		annotations: { readOnlyHint: true, openWorldHint: false },
		promptSnippet: "Record and update a multi-step implementation plan.",
		promptGuidelines: ["For multi-step implementation, create or update a relevant plan before execution and update the current step before starting it. For already authorized work, proceed without requesting separate plan approval. Submit the full state each time. Wait for create to return its identity before updating. Follow user and skill instructions, including waiting; a plan does not grant authorization. Ordinary questions need no plan. When work is merged into another step or becomes unnecessary, update or remove the superseded step and explain the change instead of leaving a stale pending item. Never mark unfinished work completed. Mark completion explicitly; never infer it from a stopped run."],
		parameters: planParameters,
		async execute(_id, args, _signal, _update, ctx) {
			const snapshot = transition(args, latestPlan(ctx.sessionManager.getBranch())?.snapshot);
			return { content: [{ type: "text", text: `Plan ${snapshot.planId}, revision ${snapshot.revision}: ${snapshot.status}.` }], details: { planSnapshot: snapshot } };
		},
	});
	pi.on("context", (event, ctx) => {
		if (!pi.getActiveTools().includes("plan") || !["builtin:pi-harness-plan", "<inline:pi-harness-plan>"].includes(pi.getAllTools().find(tool => tool.name === "plan")?.sourceInfo.path ?? "")) return;
		return { messages: restorePlanContext(event.messages, ctx.sessionManager.getBranch()) };
	});
	// Issue #63: the model often finishes the work but never submits a closing
	// plan call, leaving the progress panel frozen mid-plan. When a normally
	// completed turn leaves an active plan that looks concluded, remind it once
	// (per plan, per user request) to record the terminal state. The reminder
	// is a visible auto-reminder event — the only host-initiated model call
	// besides the unexecuted tool-text reminder (see AGENTS.md).
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "completed" || !pi.getActiveTools().includes("plan")) return;
		const branch = ctx.sessionManager.getBranch();
		const latest = latestPlan(branch);
		if (!latest || latest.snapshot.status !== "active" || !planLooksConcluded(event, latest)) return;
		const user = [...branch].reverse().find(entry => entry.type === "message" && entry.message.role === "user" && userText(entry.message.content) !== TOOL_TEXT_CONTINUE_PROMPT)?.id ?? "";
		const state = reminded.get(ctx.sessionManager) ?? new Map();
		if (state.get(latest.snapshot.planId) === user) return;
		state.set(latest.snapshot.planId, user);
		reminded.set(ctx.sessionManager, state);
		const content = `Plan status reminder: this turn's step work has concluded, but the plan below is still active. If the work is complete, submit an update with status completed (full state, all steps). If a step genuinely failed, use status failed. If you are intentionally pausing for the user, leave the plan active and reply normally. This reminder does not authorize new work; do not redo or extend the task.\n${JSON.stringify({ action: "update", planId: latest.snapshot.planId, expectedRevision: latest.snapshot.revision, ...editableState(latest.snapshot) })}`;
		return { entries: [{ type: "custom_message", customType: PLAN_REMINDER_TYPE, content, display: true }], continue: true };
	});
};
