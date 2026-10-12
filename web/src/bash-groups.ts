import type { UiContentBlock, UiMessage } from "../../server/protocol.js";

/** Tools rendered as rows of the shared process list (3a): commands, reads and searches. */
export const PROCESS_TOOLS = new Set(["bash", "read", "grep"]);

/** Thinking and process tool calls share one list; prose, edits and other tools end it. */
export function isProcessBlock(block: UiContentBlock): boolean {
	if (block.type === "thinking") return true;
	return block.type === "toolCall" && typeof block.name === "string" && PROCESS_TOOLS.has(block.name);
}

export interface ProcessGroups {
	/** Display copies: owners carry the merged rows, donors lose their leading rows. */
	projected: Map<string, UiMessage>;
	/** Fully absorbed message → owner. */
	owners: Map<string, string>;
	/** Tool call → source message. */
	sources: Map<string, string>;
	/** Owner still open for the next message. */
	owner?: string;
}

/** Fold one message into the groups (mutates `groups`). */
function step(groups: ProcessGroups, byId: Map<string, UiMessage>, message: UiMessage) {
	const { projected, owners, sources } = groups;
	for (const block of message.content) if (block.type === "toolCall" && typeof block.id === "string") sources.set(block.id, message.id);
	if (message.role === "toolResult") return;
	// Aborted/errored messages keep their own "not executed" state (issue #66).
	const settled = message.role === "assistant" && !message.errorMessage && message.stopReason !== "aborted" && message.stopReason !== "error";
	const owner = groups.owner ? projected.get(groups.owner) ?? byId.get(groups.owner) : undefined;
	let lead = 0;
	if (settled) while (lead < message.content.length && isProcessBlock(message.content[lead])) lead++;
	if (owner && lead > 0) {
		projected.set(owner.id, { ...owner, content: [...owner.content, ...message.content.slice(0, lead)] });
		if (lead === message.content.length) { owners.set(message.id, owner.id); return; }
		// Leading thinking/commands of a reply continue the list above its prose.
		projected.set(message.id, { ...message, content: message.content.slice(lead) });
	}
	const last = message.content.at(-1);
	groups.owner = settled && last && isProcessBlock(last) ? message.id : undefined;
	byId.set(message.id, message);
}

/** Merge thinking, commands, reads and searches across assistant messages and their
 * invisible results into one list per stretch between prose paragraphs.
 * Never cross user/text/edit/event boundaries, errors or the history fold boundary.
 * Source IDs remain anchors in MessageList, so navigation still reaches a group.
 */
export function groupBashMessages(messages: UiMessage[], start = 0, barriers = new Set<number>()): ProcessGroups {
	const groups: ProcessGroups = { projected: new Map(), owners: new Map(), sources: new Map() };
	const byId = new Map<string, UiMessage>();
	for (let i = start; i < messages.length; i++) {
		if (barriers.has(i)) groups.owner = undefined;
		step(groups, byId, messages[i]);
	}
	return groups;
}

/** Add the streaming message without re-projecting history, so settled owners keep identity. */
export function withStreamingMessage(groups: ProcessGroups, messages: UiMessage[], streaming: UiMessage | null | undefined): ProcessGroups {
	if (!streaming) return groups;
	const next: ProcessGroups = { projected: new Map(groups.projected), owners: new Map(groups.owners), sources: new Map(groups.sources), owner: groups.owner };
	const owner = groups.owner ? messages.find(message => message.id === groups.owner) : undefined;
	step(next, new Map(owner ? [[owner.id, owner]] : []), streaming);
	return next;
}
