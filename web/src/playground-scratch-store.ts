import type { PlaygroundScratch, PlaygroundTestConfig } from "../../server/protocol.js";

export const SCRATCH_EXAMPLE = `def add(a: int, b: int) -> int:
    return a + b


if __name__ == "__main__":
    print(add(2, 3))
`;
export const EMPTY_SCRATCH_TESTS: PlaygroundTestConfig = { mode: "program", selectedMethod: "", casesByMethod: {} };
export type ScratchDraft = { content: string; tests: PlaygroundTestConfig };
export interface ScratchTransport {
	read(): Promise<PlaygroundScratch>;
	write(draft: ScratchDraft): Promise<void>;
}
export interface ScratchState {
	doc: ScratchDraft | null;
	loadFailed: boolean;
	saveState: "pending" | "saving" | "saved" | "error";
	savedAt: number | null;
}

/** One draft owner across React mounts. Callers never coordinate writes or acknowledgements. */
export class PlaygroundScratchStore {
	private state: ScratchState = { doc: null, loadFailed: false, saveState: "saved", savedAt: null };
	private listeners = new Set<() => void>();
	private mounts = 0;
	private generation = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private queue: Promise<boolean> = Promise.resolve(true);
	private queued: string | null = null;
	private persisted: string | null = null;
	private pending = 0;

	constructor(private readonly transport: ScratchTransport) {}
	getSnapshot = (): ScratchState => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	private publish(patch: Partial<ScratchState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	private clearTimer(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** Last view leaving flushes; a re-entering view waits before reading persisted data. */
	connect = (): (() => void) => {
		if (++this.mounts === 1) void this.load(++this.generation);
		let connected = true;
		return () => {
			if (!connected) return;
			connected = false;
			if (--this.mounts === 0) {
				++this.generation;
				void this.flush();
			}
		};
	};
	private async load(generation: number): Promise<void> {
		await this.queue;
		if (generation !== this.generation) return;
		// A failed flush must not be replaced by an older server copy on re-entry.
		if (this.state.doc && (this.pending || JSON.stringify(this.state.doc) !== this.persisted)) return;
		const before = this.state.doc;
		try {
			const stored = await this.transport.read();
			if (generation !== this.generation || this.state.doc !== before) return;
			this.persisted = stored.updatedAt ? JSON.stringify({ content: stored.content, tests: stored.tests }) : null;
			this.queued = null;
			const doc: ScratchDraft = {
				content: stored.updatedAt === 0 && !stored.content ? SCRATCH_EXAMPLE : stored.content,
				tests: { ...(stored.tests ?? EMPTY_SCRATCH_TESTS), mode: stored.tests?.mode ?? "program" },
			};
			this.publish({ doc, loadFailed: false, savedAt: null, saveState: "saved" });
			this.schedule();
		} catch {
			if (generation === this.generation && this.state.doc === before) this.publish({ loadFailed: true });
		}
	}

	edit = (update: ScratchDraft | ((draft: ScratchDraft) => ScratchDraft)): void => {
		if (!this.state.doc) return;
		const doc = typeof update === "function" ? update(this.state.doc) : update;
		this.publish({ doc });
		this.schedule();
	};
	private schedule(): void {
		this.clearTimer();
		const serialized = JSON.stringify(this.state.doc);
		if (this.pending && serialized === this.queued) {
			this.publish({ saveState: "saving" });
		} else if (!this.pending && serialized === this.persisted) {
			this.publish({ saveState: "saved" });
		} else {
			this.publish({ saveState: "pending" });
			this.timer = setTimeout(() => { void this.flush(); }, 600);
		}
	}

	/** Resolves false on failure, retaining the latest editable draft for retry. */
	flush = (): Promise<boolean> => {
		this.clearTimer();
		if (!this.state.doc) return Promise.resolve(true);
		const serialized = JSON.stringify(this.state.doc);
		if (this.pending && serialized === this.queued) return this.queue;
		if (!this.pending && serialized === this.persisted) return Promise.resolve(true);
		// Freeze the payload; later edits cannot mutate an enqueued write.
		const draft = JSON.parse(serialized) as ScratchDraft;
		this.queued = serialized;
		++this.pending;
		this.publish({ saveState: "saving" });
		this.queue = this.queue.then(async () => {
			let ok = false;
			try {
				await this.transport.write(draft);
				this.persisted = serialized;
				ok = true;
			} catch { /* A failed write must not poison subsequent writes. */ }
			--this.pending;
			if (!this.pending) {
				this.queued = null;
				if (JSON.stringify(this.state.doc) === serialized) {
					this.publish({ saveState: ok ? "saved" : "error", ...(ok ? { savedAt: Date.now() } : {}) });
				} else {
					// Newer edits own the displayed status, including when this write failed.
					this.schedule();
					if (!this.mounts) void this.flush();
				}
			}
			return ok;
		});
		return this.queue;
	};
}
