import type { UiMessage, UiToolCallBlock } from "../../server/protocol.js";

/** One display group per real user turn. Calls and results remain untouched. */
export function subagentTurns(messages: readonly UiMessage[]): Map<string, UiToolCallBlock[]> {
	const groups = new Map<string, UiToolCallBlock[]>();
	let calls: UiToolCallBlock[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role === "user" && message.origin !== "auto-reminder") calls = [];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "subagent" || typeof block.id !== "string" || seen.has(block.id)) continue;
			try {
				if (JSON.parse(typeof block.argumentsText === "string" ? block.argumentsText : "").action !== "run") continue;
			} catch { continue; }
			seen.add(block.id);
			calls.push(block as UiToolCallBlock);
			groups.set(block.id, calls);
		}
	}
	return groups;
}
