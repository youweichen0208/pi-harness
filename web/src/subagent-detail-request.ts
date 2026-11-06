import type { SubagentResponse, UiSubagentTaskDetail } from "../../server/protocol.js";
import { randomUuid } from "./uuid.js";

/** Transport lifecycle is independent of the task lifecycle, including terminal first loads. */
export class SubagentDetailRequest {
	private pending?: { id: string; at: number };
	private stopPending?: { id: string; at: number };
	private cursor = 0;
	private retries = 0;
	private paused = false;
	private finished = false;
	private closed = false;
	private detail?: UiSubagentTaskDetail;
	constructor(private taskId: string, private send: (request: { requestId: string; taskId: string; action: "detail" | "stop"; cursor: number }) => void, private receive: (detail: UiSubagentTaskDetail) => void, private error: (failed: boolean) => void) {}
	request(action: "detail" | "stop" = "detail") {
		if (this.closed) return;
		const pending = { id: randomUuid(), at: Date.now() };
		if (action === "stop") { if (this.stopPending) return; this.stopPending = pending; }
		else this.pending = pending;
		this.send({ requestId: pending.id, taskId: this.taskId, action, cursor: this.cursor });
	}
	retry() {
		this.paused = false; this.retries = 0; this.finished = false;
		this.request();
	}
	tick() {
		if (this.closed) return;
		if (this.stopPending && Date.now() - this.stopPending.at >= 10000) { this.stopPending = undefined; this.error(true); }
		if (this.pending) {
			if (Date.now() - this.pending.at < 10000) return;
			this.pending = undefined; this.error(true);
			if (this.retries++ === 0) this.request();
			else this.paused = true;
		} else if (!this.finished && !this.paused) this.request();
	}
	response(message: SubagentResponse) {
		if (this.closed || message.taskId !== this.taskId) return;
		const stop = message.requestId === this.stopPending?.id;
		if (!stop && message.requestId !== this.pending?.id) return;
		if (stop) {
			this.stopPending = undefined;
			// Stop acknowledgements never consume the detail cursor or cancel an in-flight page.
			if (message.error) this.error(true);
			else if (message.detail) {
				this.detail = { ...message.detail, events: this.detail?.events ?? [] };
				this.receive(this.detail);
				this.paused = false; this.finished = false;
			}
			return;
		}
		this.pending = undefined;
		if (message.error || !message.detail) { this.paused = true; this.error(true); return; }
		this.retries = 0; this.paused = false; this.error(false);
		const next = message.detail;
		const events = new Map((this.detail?.events ?? []).map(event => [event.seq, event]));
		for (const event of next.events) events.set(event.seq, event);
		this.cursor = Math.max(this.cursor, next.nextCursor ?? 0, ...next.events.map(event => event.seq + 1));
		this.finished = ["completed", "failed", "cancelled"].includes(next.task.phase) && next.nextCursor === undefined;
		this.detail = { ...next, events: [...events.values()].sort((a, b) => a.seq - b.seq) };
		this.receive(this.detail);
		if (next.nextCursor !== undefined) this.request();
	}
	close() { this.closed = true; this.pending = undefined; this.stopPending = undefined; }
}
