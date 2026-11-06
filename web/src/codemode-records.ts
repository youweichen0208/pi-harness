import type { ServerMessage, UiCodemodeDetails, UiMessage, UiState, UiToolCallBlock } from "../../server/protocol.js";
import { isToolTextContinuation } from "../../server/tool-text.js";

type LiveStatus = Pick<Extract<ServerMessage, { type: "tool_status" }>, "toolCallId" | "toolName" | "isError" | "parentToolCallId" | "running" | "argumentsText" | "durationMs"> & { conversationId?: string };
export interface CodemodeActivity {
	codemode?: UiState["codemode"];
	liveOutputs?: ReadonlyMap<string, { codemode?: UiCodemodeDetails }>;
	toolStatuses?: ReadonlyMap<string, LiveStatus>;
}
export type CodemodeCall = Omit<UiCodemodeDetails["calls"][number], "status"> & { key: number; status: UiCodemodeDetails["calls"][number]["status"] | "unfinished" };

/** Native details and nested events describe the same work: prefer one source, never concatenate. */
export function codemodeRecords(details: UiCodemodeDetails | undefined, nested: UiMessage["nestedCalls"], ended: boolean) {
	const source = details?.calls ?? nested?.calls.map(call => ({ ...call, args: call.argumentsText ?? "", status: call.status === "unfinished" ? "running" as const : call.status })) ?? [];
	const calls: CodemodeCall[] = source.slice(0, 256).map((call, key) => ({ ...call, key, status: ended && call.status === "running" ? "unfinished" : call.status }));
	return { calls, countKnown: !!details || nested?.complete === true, incompleteHistory: ended && !details && nested?.complete === false, totalCalls: Math.max(details?.totalCalls ?? source.length, source.length), omitted: Math.max(0, (details?.totalCalls ?? source.length) - calls.length) };
}
export interface CodemodeGroup extends ReturnType<typeof codemodeRecords> {
	id: string;
	messageId: string;
	entryId?: string;
	requestId: string;
	status: "running" | "queued" | "completed" | "failed" | "cancelled" | "unfinished";
	durationMs?: number;
}

export function currentCodemodeGroups(messages: readonly UiMessage[], live: UiMessage | null | undefined, streaming: boolean, activity: CodemodeActivity = {}, conversationId?: string): CodemodeGroup[] {
	const transcript = [...(activity.codemode?.history ?? messages)];
	if (live) {
		const index = transcript.findIndex(message => message.id === live.id);
		if (index >= 0) transcript[index] = live; else transcript.push(live);
	}
	const start = transcript.findLastIndex((message, index) => message.role === "user" && message.origin !== "auto-reminder" && !isToolTextContinuation(transcript, index) && message.content.some(part => part.type === "text"));
	if (start < 0) return [];
	const tail = transcript.slice(start + 1);
	const results = new Map(tail.filter(message => message.role === "toolResult" && message.toolCallId).map(message => [message.toolCallId!, message]));
	const cancelled = tail.some(message => message.role === "assistant" && message.stopReason === "aborted");
	const statuses = [...(activity.toolStatuses?.values() ?? [])].filter(status => !status.conversationId || !conversationId || status.conversationId === conversationId);
	const groups: CodemodeGroup[] = [];
	const seen = new Set<string>();
	for (const message of tail) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || part.name !== "codemode" || typeof part.id !== "string" || seen.has(part.id)) continue;
			const block = part as UiToolCallBlock;
			seen.add(block.id);
			const result = results.get(block.id);
			const status = statuses.find(item => item.toolCallId === block.id);
			const details = result?.codemode ?? activity.liveOutputs?.get(block.id)?.codemode ?? activity.codemode?.live.find(item => item.toolCallId === block.id)?.details;
			const nestedStatuses = statuses.filter(item => item.parentToolCallId === block.id);
			const nested = result?.nestedCalls ?? (nestedStatuses.length ? { complete: false, calls: nestedStatuses.map(item => ({ id: item.toolCallId, name: item.toolName, argumentsText: item.argumentsText, durationMs: item.durationMs, status: item.running ? "unfinished" as const : item.isError ? "error" as const : "ok" as const })) } : undefined);
			const ended = !!result || !!status && !status.running || !streaming || message.stopReason === "aborted" || message.stopReason === "error";
			const records = codemodeRecords(details, nested, ended);
			const groupStatus: CodemodeGroup["status"] = result ? result.isError ? "failed" : "completed" : status && !status.running ? status.isError ? "failed" : "completed" : ended ? cancelled ? "cancelled" : "unfinished" : details || nested || status?.running ? "running" : "queued";
			groups.push({ ...records, id: block.id, messageId: message.id, entryId: result?.entryId ?? message.entryId, requestId: transcript[start].id, status: groupStatus, durationMs: result?.durationMs ?? status?.durationMs });
		}
	}
	return groups;
}
