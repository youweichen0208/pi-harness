import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { UiRunRecovery } from "./protocol.js";
import { RepetitionDetector } from "./repetition-detector.js";
import { TOOL_TEXT_CONTINUE_PROMPT } from "./tool-text.js";

export const RUN_RECOVERY_ENTRY = "pi-harness:run-recovery";
export const RUN_CONTINUATION = "pi-harness:run-continuation";
const PROTECTION_ENTRY = "pi-harness:repetition-protection";
type Reason = UiRunRecovery["reason"];
type Assistant = Extract<AgentSession["messages"][number], { role: "assistant" }>;
interface RecordState {
	root: string;
	counts: Record<Reason, number>;
	status?: UiRunRecovery;
}
interface RecoveryHost {
	current(): boolean;
	admitted(): boolean;
	changed(): void;
	interrupt(): Promise<void>;
	/** Acquire the same model/configuration admission used by ordinary prompts. */
	prepare(): Promise<() => void>;
	/** Verify native transcript writability independently of auto-run admission. */
	verifyEdit?(): Promise<void>;
	writable?(): boolean;
	toolText(): Promise<void>;
}

/** One coordinator per native session. Persistence is branch-local and never
 * starts work on restore; only a newly observed run can schedule a continuation. */
export class RunRecoveryCoordinator {
	private record: RecordState = { root: "", counts: { length: 0, repetition: 0, "tool-text": 0 } };
	private epoch = 0;
	private quarantineEpoch = 0;
	private cancelled = false;
	private userStopped = false;
	private working?: symbol;
	private timer?: ReturnType<typeof setTimeout>;
	private nativeFailed = false;
	private message?: Assistant;
	private detectors = new Map<number, RepetitionDetector>();
	private latched = false;
	protection = true;
	constructor(readonly session: AgentSession, private readonly host: RecoveryHost) {
		const root = this.rootId();
		for (const entry of session.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === PROTECTION_ENTRY && typeof entry.data === "boolean") this.protection = entry.data;
			if (entry.customType !== RUN_RECOVERY_ENTRY || !entry.data || typeof entry.data !== "object") continue;
			const data = entry.data as RecordState;
			if (data.root === root && data.counts && ["length", "repetition", "tool-text"].every(k => Number.isSafeInteger(data.counts[k as Reason]) && data.counts[k as Reason] >= 0)) {
				this.record = { ...data, counts: { ...data.counts }, status: data.status ? { ...data.status, phase: "stopped", ...(data.status.phase !== "stopped" ? { detail: "cancelled" as const } : {}) } : undefined };
			}
		}
	}
	get status(): UiRunRecovery | undefined { return this.record.status; }
	get pending(): boolean { return !!this.working || !!this.timer; }
	private rootId(): string {
		return this.session.sessionManager.getBranch().findLast(entry => {
			if (entry.type !== "message" || entry.message.role !== "user") return false;
			const content = entry.message.content;
			const text = typeof content === "string" ? content : content.filter(b => b.type === "text").map(b => b.text).join("\n");
			return text !== TOOL_TEXT_CONTINUE_PROMPT;
		})?.id ?? "";
	}
	private syncRoot(): void {
		const root = this.rootId();
		if (root === this.record.root) return;
		this.epoch++;
		this.working = undefined;
		this.cancelled = false;
		this.userStopped = false;
		this.nativeFailed = false;
		this.record = { root, counts: { length: 0, repetition: 0, "tool-text": 0 } };
	}
	private save(status: UiRunRecovery | undefined, persist = true): void {
		this.record = { ...this.record, counts: { ...this.record.counts }, status };
		if (persist && this.host.writable?.() !== false) this.session.sessionManager.appendCustomEntry(RUN_RECOVERY_ENTRY, { ...this.record, counts: { ...this.record.counts }, status: status ? { ...status } : undefined });
		this.host.changed();
	}
	setProtection(enabled: boolean): void {
		if (this.host.writable?.() === false) return;
		this.protection = enabled;
		this.session.sessionManager.appendCustomEntry(PROTECTION_ENTRY, enabled);
		this.detectors.clear();
		if (!enabled && this.status?.reason === "repetition" && this.status.phase !== "stopped") this.cancel();
		this.host.changed();
	}
	cancel(userStop = false, preserveQuarantine = false): void {
		this.epoch++;
		if (!userStop && !preserveQuarantine) this.quarantineEpoch++;
		this.cancelled = true;
		this.userStopped = userStop;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.record.status && this.record.status.phase !== "stopped" && this.host.current()) this.save({ ...this.record.status, phase: "stopped", detail: "cancelled" });
	}
	dispose(): void { this.cancel(); this.detectors.clear(); }
	private limit(reason: Reason): number { return reason === "length" ? 2 : 1; }
	private available(reason: Reason): boolean {
		return this.record.counts[reason] < this.limit(reason) && Object.values(this.record.counts).reduce((a, b) => a + b, 0) < 3;
	}
	/** Existing tool-text remediation shares this budget rather than starting a new user task. */
	reserveToolText(): boolean {
		this.syncRoot();
		if (this.cancelled || !this.available("tool-text")) return false;
		this.record.counts["tool-text"]++;
		this.save(undefined);
		return true;
	}
	private eligible(epoch: number, root: string): boolean {
		return this.host.current() && !this.cancelled && this.epoch === epoch && this.rootId() === root && this.host.admitted() && this.session.isIdle && !this.session.getSteeringMessages().length && !this.session.getFollowUpMessages().length;
	}
	observe(event: AgentSessionEvent): void {
		if (!this.host.current()) return;
		if (event.type === "compaction_end" && (!event.result || event.aborted) || event.type === "auto_retry_end" && !event.success) this.nativeFailed = true;
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.syncRoot(); this.message = event.message; this.detectors.clear(); this.latched = false;
		}
		if (event.type === "message_update" && event.message.role === "assistant") {
			const delta = event.assistantMessageEvent;
			if (!this.protection || this.latched || this.userStopped || (delta.type !== "text_delta" && delta.type !== "thinking_delta")) return;
			if (this.message?.timestamp !== event.message.timestamp) { this.syncRoot(); this.message = event.message; this.detectors.clear(); }
			let detector = this.detectors.get(delta.contentIndex);
			if (!detector) { detector = new RepetitionDetector(delta.type === "text_delta" ? "text" : "thinking"); this.detectors.set(delta.contentIndex, detector); }
			if (detector.push(delta.delta)) {
				this.latched = true;
				const message = event.message;
				const epoch = this.epoch, root = this.record.root;
				void this.stopRepeated(message).catch(() => { if (this.epoch === epoch && this.rootId() === root && !this.cancelled) this.fail("repetition"); });
			}
		}
		if (event.type === "agent_settled" && !event.aborted && !this.latched) this.schedule();
	}
	private fail(reason: Reason): void {
		if (this.host.current()) this.save({ reason, phase: "stopped", attempt: this.record.counts[reason], limit: this.limit(reason), detail: "failed" });
	}
	private async stopRepeated(message: Assistant): Promise<void> {
		if (this.working) return;
		const operation = Symbol();
		this.working = operation;
		const epoch = this.epoch, root = this.record.root;
		const quarantineEpoch = this.quarantineEpoch;
		this.save({ reason: "repetition", phase: "stopping", attempt: this.record.counts.repetition, limit: 1 }, false);
		try {
			// Leave the SDK event delivery stack before interrupting its active run.
			await new Promise<void>(resolve => setImmediate(resolve));
			if (!this.host.current() || this.quarantineEpoch !== quarantineEpoch || this.rootId() !== root || this.message?.timestamp !== message.timestamp) return;
			// A provider may send its final repeated delta and stop in the same
			// tick. Quarantine it without forcing an already-idle runtime to reset.
			if (!this.session.isIdle) await this.host.interrupt();
			// Cancelling continuation (for example, a queued user prompt) must not
			// prevent quarantine of this same interrupted assistant response.
			if (!this.host.current() || this.quarantineEpoch !== quarantineEpoch || this.rootId() !== root || this.message?.timestamp !== message.timestamp) return;
			const matches = this.session.sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.timestamp === message.timestamp);
			const entry = matches.length === 1 ? matches[0] : undefined;
			if (!this.session.isIdle || entry?.type !== "message" || entry.message.role !== "assistant" || entry.message.content.some(b => b.type === "toolCall")) {
				this.save({ reason: "repetition", phase: "stopped", attempt: this.record.counts.repetition, limit: 1, detail: "unsafe" }); return;
			}
			// The SDK emits message_end before persisting it. Only edit after abort
			// has settled, and leave all earlier tool-call/result pairs untouched.
			await this.host.verifyEdit?.();
			if (!this.host.current() || this.quarantineEpoch !== quarantineEpoch || this.rootId() !== root || this.message?.timestamp !== message.timestamp || !this.session.isIdle) return;
			this.session.sessionManager.appendContextEdit(entry.id, null);
			this.session.refreshContext();
			this.host.changed();
			if (!this.eligible(epoch, root)) { this.save({ reason: "repetition", phase: "stopped", attempt: this.record.counts.repetition, limit: 1, detail: "cancelled" }); return; }
			await this.continue("repetition", epoch, root);
		} finally { if (this.working === operation) this.working = undefined; }
	}
	private schedule(): void {
		if (this.timer || this.cancelled) return;
		const epoch = this.epoch, root = this.record.root;
		// Never start a run inside agent_settled: the SDK waits for actions
		// registered in that callback, which would make abort wait for the retry.
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.afterSettled(epoch, root).catch(() => { if (this.epoch === epoch && this.rootId() === root && !this.cancelled) this.fail("length"); });
		}, 0);
	}
	private async afterSettled(epoch: number, root: string): Promise<void> {
		if (this.working || !this.eligible(epoch, root)) return;
		const operation = Symbol();
		this.working = operation;
		try {
			await this.host.verifyEdit?.();
			if (!this.eligible(epoch, root)) return;
			const last = this.session.messages.findLast(m => m.role === "assistant");
			if (last?.role !== "assistant") return;
			if (this.nativeFailed) { if (last.stopReason === "length") this.fail("length"); return; }
			if (last.stopReason !== "length") {
				if (this.record.status?.phase === "recovering") this.save(undefined);
				this.working = undefined;
				void this.host.toolText().catch(() => { if (this.epoch === epoch && !this.cancelled) this.fail("tool-text"); }); return;
			}
			const text = last.content.filter(b => b.type === "text").map(b => b.text).join("\n");
			const detail = last.content.some(b => b.type === "toolCall") ? "unsafe" : !/[\p{L}\p{N}]/u.test(text) ? "thinking-only" : undefined;
			if (detail) { this.save({ reason: "length", phase: "stopped", attempt: this.record.counts.length, limit: 2, detail }); return; }
			await this.continue("length", epoch, root);
		} finally { if (this.working === operation) this.working = undefined; }
	}
	private async continue(reason: "length" | "repetition", epoch: number, root: string): Promise<void> {
		if (!this.available(reason)) { this.save({ reason, phase: "stopped", attempt: this.record.counts[reason], limit: this.limit(reason), detail: "exhausted" }); return; }
		const leaf = this.session.sessionManager.getLeafId();
		const release = await this.host.prepare();
		if (!this.eligible(epoch, root) || this.session.sessionManager.getLeafId() !== leaf) {
			release();
			if (this.host.current() && this.epoch === epoch && this.rootId() === root) this.save({ reason, phase: "stopped", attempt: this.record.counts[reason], limit: this.limit(reason), detail: "cancelled" });
			return;
		}
		const attempt = ++this.record.counts[reason], limit = this.limit(reason);
		this.save({ reason, phase: "recovering", attempt, limit });
		const content = reason === "repetition"
			? "上一次生成因重复输出已中止，异常回复已隔离。此前已执行的工具调用和结果均已保留。请从尚未完成的步骤继续，不要重复已完成的操作；需要操作时通过真实工具调用执行，任务已完成则直接给出结果。"
			: "上一次回复因输出额度耗尽而截断。请从已有内容和工具结果继续完成尚未完成的部分，不要重写已有正文或重复已完成的操作；任务完成后直接结束。";
		// Do not hold the coordinator lock for the model run: its next response
		// must itself be interruptible by the repetition guard.
		this.working = undefined;
		void this.session.sendCustomMessage({ customType: RUN_CONTINUATION, content, display: true, details: { reason, attempt, limit, requestEntryId: root } }, { triggerTurn: true })
			.catch(() => { if (this.epoch === epoch && !this.cancelled) this.fail(reason); })
			.finally(release);
	}
}
