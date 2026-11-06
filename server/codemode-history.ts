import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { UiCodemodeDetails, UiMessage, UiState, UiToolCallBlock } from "./protocol.js";
import { serializeMessage, type AgentMessage } from "./serialize.js";
import { isToolTextContinuation } from "./tool-text.js";

/** Display metadata only. Native branch entries remain the source of truth. */
export class CodemodeHistory {
	private manager?: SessionManager;
	private revision = "";
	private history: UiMessage[] = [];
	readonly live = new Map<string, UiCodemodeDetails>();

	snapshot(manager: SessionManager, serialize: (message: AgentMessage, entryId: string) => UiMessage | null): NonNullable<UiState["codemode"]> {
		if (this.manager !== manager) { if (this.manager) this.live.clear(); this.manager = manager; this.revision = ""; }
		const revision = `${manager.getLeafId()}:${manager.getEntryCount()}`;
		if (revision !== this.revision) {
			const branch = manager.getBranch().filter(entry => entry.type === "message");
			let start = -1;
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry = branch[index];
				if (entry.message.role !== "user") continue;
				const user = serialize(entry.message, entry.id);
				if (!user || user.role !== "user" || user.origin === "auto-reminder") continue;
				const previous = branch[index - 1];
				const before = previous?.message.role === "assistant" ? serialize(previous.message, previous.id) : null;
				if (before && isToolTextContinuation([before, user], 1)) continue;
				start = index; break;
			}
			// Do not serialize old requests or unrelated output bodies on each new leaf.
			const tail = start < 0 ? [] : branch.slice(start).flatMap(entry => {
				const message = entry.message;
				const relevant = entry === branch[start] || message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error" || message.content.some(block => block.type === "toolCall" && block.name === "codemode")) || message.role === "toolResult" && message.toolName === "codemode";
				if (!relevant) return [];
				const value = serialize(message, entry.id);
				return value ? [{ ...value, entryId: entry.id }] : [];
			});
			const ids = new Set(tail.flatMap(message => message.role === "assistant" ? message.content.flatMap(block => block.type === "toolCall" && block.name === "codemode" ? [block.id] : []) : []));
			this.history = tail.flatMap<UiMessage>(message => {
				if (message === tail[0] && message.role === "user") return [{ id: message.id, entryId: message.entryId, role: "user" as const, content: [{ type: "text" as const, text: "" }] }];
				if (message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error" || message.content.some(block => block.type === "toolCall" && block.name === "codemode"))) return [{ id: message.id, entryId: message.entryId, role: message.role, stopReason: message.stopReason, content: message.content.flatMap(block => block.type === "toolCall" && block.name === "codemode" ? [{ type: "toolCall" as const, id: block.id, name: "codemode", argumentsText: "" }] : []) }];
				if (message.role === "toolResult" && ids.has(message.toolCallId)) {
					this.live.delete(message.toolCallId!);
					return [{ id: message.id, entryId: message.entryId, role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, durationMs: message.durationMs, codemode: message.codemode, nestedCalls: message.nestedCalls, content: [] }];
				}
				return [];
			});
			for (const id of this.live.keys()) if (!ids.has(id)) this.live.delete(id);
			this.revision = revision;
		}
		return { history: this.history, live: [...this.live].map(([toolCallId, details]) => ({ toolCallId, details })) };
	}
}

/** Read one call on the active branch without navigating or changing model context. */
export function codemodeHistoryContent(manager: SessionManager, entryId: string, toolCallId: string) {
	const branch = manager.getBranch();
	const selected = branch.find(entry => entry.id === entryId);
	if (selected?.type !== "message") throw new Error("Codemode entry is no longer on the active branch");
	const owner = branch.find(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(block => block.type === "toolCall" && block.name === "codemode" && block.id === toolCallId));
	if (owner?.type !== "message") throw new Error("Codemode call not found");
	const result = branch.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId);
	if (entryId !== owner.id && entryId !== result?.id) throw new Error("Codemode entry does not match call");
	const message = serializeMessage(owner.message, 0)!;
	const block = message.content.find(block => block.type === "toolCall" && block.id === toolCallId) as UiToolCallBlock;
	return { block, result: result?.type === "message" ? serializeMessage(result.message, 0) ?? undefined : undefined };
}
