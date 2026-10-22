export interface WikiIdentity { cwd?: string; conversationId: string; sessionId?: string }
function sameIdentity(a: WikiIdentity, b: WikiIdentity) {
	return a.cwd === b.cwd && a.conversationId === b.conversationId && a.sessionId === b.sessionId;
}

export class WikiCoordinationError extends Error {
	constructor(readonly reason: "changed" | "timeout") {
		super(reason === "changed" ? "Conversation changed while waiting for interruption" : "Interruption timed out; retry when the conversation is idle");
	}
}

/** Owns Wiki operation admission and interrupt completion independently of React. */
export class WikiCoordinator {
	private operation: symbol | null = null;
	private listeners = new Set<() => void>();
	private observed: { conversationId: string; streaming: boolean; ready: boolean; sessionId?: string } | null = null;
	private waiters = new Set<() => void>();
	busy = () => this.operation !== null;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	begin() {
		if (this.operation) return null;
		const token = Symbol(); this.operation = token; this.notify();
		return {
			current: () => this.operation === token,
			accepts: (current: WikiIdentity, source: WikiIdentity, target?: WikiIdentity) => this.operation === token && (sameIdentity(current, source) || (!!target && sameIdentity(current, target))),
			release: () => {
				if (this.operation === token) { this.operation = null; this.notify(); }
			},
		};
	}
	private notify() { for (const listener of this.listeners) listener(); }
	observe(conversationId: string, streaming: boolean, ready: boolean, sessionId?: string) {
		this.observed = { conversationId, streaming, ready, sessionId };
		for (const waiter of this.waiters) waiter();
	}
	waitSettled(conversationId: string, timeout = 30000, sessionId?: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const finish = (error?: Error) => { clearTimeout(timer); this.waiters.delete(check); error ? reject(error) : resolve(); };
			const check = () => {
				if (!this.observed?.ready) return;
				if (this.observed.conversationId !== conversationId || (sessionId !== undefined && this.observed.sessionId !== sessionId)) { finish(new WikiCoordinationError("changed")); return; }
				if (!this.observed.streaming) finish();
			};
			const timer = setTimeout(() => finish(new WikiCoordinationError("timeout")), timeout);
			this.waiters.add(check); check();
		});
	}
}
export type WikiOperation = NonNullable<ReturnType<WikiCoordinator["begin"]>>;
