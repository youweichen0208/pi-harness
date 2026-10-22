import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./serialize.js";
import type { UiMessage } from "./protocol.js";

const cache = new WeakMap<SessionManager, { leaf: string | null; errors: UiMessage[]; order: Map<string, number> }>();

/** Context edits affect model input, not the user's record of failed requests. */
export function withSessionErrors(manager: SessionManager, messages: UiMessage[], serialize: (message: AgentMessage, entryId: string) => UiMessage | null): UiMessage[] {
	const leaf = manager.getLeafId();
	let projection = cache.get(manager);
	if (!projection || projection.leaf !== leaf) {
		const branch = manager.getBranch();
		const omitted = new Set<string>();
		for (const entry of branch) if (entry.type === "context_edit") {
			if (entry.replacement === null) omitted.add(entry.targetId);
			else omitted.delete(entry.targetId);
		}
		const errors = branch.flatMap(entry => {
			if (entry.type !== "message" || !omitted.has(entry.id) || entry.message.role !== "assistant" || entry.message.stopReason !== "error") return [];
			const value = serialize(entry.message, entry.id);
			return value ? [{ ...value, entryId: entry.id, content: [] }] : [];
		});
		projection = { leaf, errors, order: new Map(branch.map((entry, i) => [entry.id, i])) };
		cache.set(manager, projection);
	}
	if (!projection.errors.length) return messages;
	const result = [...messages];
	for (const error of projection.errors) {
		if (result.some(message => message.entryId === error.entryId || message.id === error.id)) continue;
		const errorOrder = projection.order.get(error.entryId!)!;
		const next = result.findIndex(message => {
			const order = message.entryId ? projection.order.get(message.entryId) : undefined;
			return order !== undefined ? order > errorOrder : (message.timestamp ?? Infinity) > (error.timestamp ?? 0);
		});
		result.splice(next < 0 ? result.length : next, 0, error);
	}
	return result;
}
