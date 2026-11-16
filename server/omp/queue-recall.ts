import type { ServerMessage } from "../protocol.js";

type Result = Extract<ServerMessage, { type: "queue_recalled" }>;
type Recall = { conversationId: string; pending: Promise<Result>; result?: Result };

/** Delivery receipts only: OMP remains the sole owner of executable input. */
export class OmpQueueRecalls {
	private pending = new Map<string, Recall>();
	private acknowledged = new Set<string>();
	constructor(private emit: (result: Result) => void) {}
	async recall(conversationId: string, requestId: string, take: () => Promise<Pick<Result, "text" | "images">>) {
		if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw Error("Invalid queue recall request");
		if (this.acknowledged.has(requestId)) return;
		let entry = this.pending.get(requestId);
		if (entry && entry.conversationId !== conversationId) throw Error("Queue recall belongs to another conversation");
		if (!entry) {
			if (this.pending.size >= 8) throw Error("Receive the previous recalled messages before recalling more");
			entry = { conversationId, pending: Promise.resolve().then(take).then(content => ({ type: "queue_recalled", conversationId, requestId, ...content })) };
			this.pending.set(requestId, entry);
		}
		// Retain rejected requests too: an unknown acknowledgement must never
		// clear newer messages when the same request is retried.
		entry.result = await entry.pending;
		if (this.pending.get(requestId) === entry) this.emit(entry.result);
	}
	acknowledge(conversationId: string, requestId: string) {
		const entry = this.pending.get(requestId);
		if (!entry?.result || entry.conversationId !== conversationId) return;
		this.pending.delete(requestId); this.acknowledged.add(requestId);
		if (this.acknowledged.size > 256) this.acknowledged.delete(this.acknowledged.values().next().value!);
	}
	replay(emit: (result: Result) => void) { for (const entry of this.pending.values()) if (entry.result) emit(entry.result); }
}
