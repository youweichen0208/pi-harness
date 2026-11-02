import type { UiMessage } from "../../server/protocol.js";

export interface CommandTurn {
	commands: number;
	failed: number;
	skipped: number;
	lines?: number;
	durationMs?: number;
}

/** Phase labels quote the preceding explanation, never generate a new claim. */
export function commandPhaseLabels(messages: readonly UiMessage[]) {
	const labels = new Map<string, string>();
	let label = "";
	for (const message of messages) {
		if (message.role === "toolResult") continue;
		if (message.role !== "assistant") { label = ""; continue; }
		for (const block of message.content) {
			if (block.type === "text" && typeof block.text === "string") {
				label = block.text?.trim().split(/\n\s*\n/).at(-1)?.replace(/^[#>*\s]+/, "").replace(/[*`]/g, "").replace(/\s+/g, " ") ?? "";
			} else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string" && ["bash", "read", "grep"].includes(block.name)) {
				if (label) labels.set(block.id, label);
			} else if (block.type !== "thinking") label = "";
		}
	}
	return labels;
}

/** One summary per user turn, anchored to its last assistant message. */
export function commandTurnSummaries(messages: readonly UiMessage[], running: boolean) {
	const summaries = new Map<string, CommandTurn>();
	const results = new Map(messages.filter(message => message.role === "toolResult" && message.toolCallId).map(message => [message.toolCallId!, message]));
	let ids: string[] = [];
	let tail: string | undefined;
	const finish = () => {
		if (!tail || !ids.length) return;
		const outcomes = ids.map(id => results.get(id));
		const durations = outcomes.map(result => result?.durationMs);
		const completeOutput = outcomes.every(result => result && !result.toolOutputUrl && !result.content.some(block => block.type === "text" && block.truncated));
		summaries.set(tail, {
			commands: ids.length,
			failed: outcomes.filter(result => result?.isError).length,
			skipped: outcomes.filter(result => !result).length,
			...(completeOutput ? { lines: outcomes.reduce((sum, result) => {
				const text = result!.content.map(block => block.type === "text" && typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n").replace(/\r\n/g, "\n").replace(/\n$/, "");
				return sum + (text ? text.split("\n").length : 0);
			}, 0) } : {}),
			...(durations.every(duration => typeof duration === "number" && Number.isFinite(duration) && duration >= 0) ? { durationMs: durations.reduce<number>((sum, duration) => sum + duration!, 0) } : {}),
		});
	};
	for (const message of messages) {
		if (message.role === "user" && message.origin !== "auto-reminder") { finish(); ids = []; tail = undefined; }
		if (message.role !== "assistant") continue;
		if (message.content.length || message.errorMessage) tail = message.id;
		for (const block of message.content) if (block.type === "toolCall" && block.name === "bash" && typeof block.id === "string" && !ids.includes(block.id)) ids.push(block.id);
	}
	if (!running) finish();
	return summaries;
}
