import type { UiMessage } from "../../server/protocol.js";

export interface ProcessGroup {
	id: string;
	ids: string[];
	calls: number;
	reads: number;
	commands: number;
	edits: number;
	thinkingMs: number;
	failed: boolean;
	running: boolean;
}

/** Fold only agent work. User/system events, recovery cards and final replies stay visible. */
export function processGroups(messages: UiMessage[], running: boolean) {
	const groups = new Map<string, ProcessGroup>();
	const members = new Map<string, ProcessGroup>();
	const replies = new Set<string>();
	let start = 0;
	const collect = (end: number) => {
		const segment = messages.slice(start, end);
		const last = segment.at(-1);
		const finalReply = last?.role === "assistant" && last.content.some(block => block.type === "text" && typeof block.text === "string" && block.text.trim()) && !last.content.some(block => block.type === "toolCall") ? last.id : null;
		const work = segment.filter(message => message.id !== finalReply);
		if (!work.some(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" || block.type === "thinking"))) return;
		const group: ProcessGroup = { id: work[0].id, ids: work.map(message => message.id), calls: 0, reads: 0, commands: 0, edits: 0, thinkingMs: 0, failed: !!last?.errorMessage || last?.stopReason === "aborted" || last?.stopReason === "error", running: running && end === messages.length };
		const calls = new Set<string>();
		for (const message of work) {
			group.failed ||= !!message.isError;
			for (const block of message.content) {
				if (block.type === "thinking") group.thinkingMs += typeof block.durationMs === "number" ? block.durationMs : 0;
				if (block.type !== "toolCall" || typeof block.id !== "string" || calls.has(block.id)) continue;
				calls.add(block.id);
				group.calls++;
				if (block.name === "read") group.reads++;
				if (block.name === "bash") group.commands++;
				if (block.name === "edit" || block.name === "write") group.edits++;
			}
		}
		groups.set(group.id, group);
		if (finalReply) replies.add(finalReply);
		for (const id of group.ids) members.set(id, group);
	};
	messages.forEach((message, index) => {
		if ((message.role !== "assistant" && message.role !== "toolResult") || message.toolText || message.origin || message.errorMessage || message.stopReason === "error" || message.stopReason === "aborted") {
			collect(index);
			start = index + 1;
		}
	});
	collect(messages.length);
	return { groups, members, replies };
}
