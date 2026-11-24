import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { RUN_CONTINUATION, RUN_RECOVERY_ENTRY, RunRecoveryCoordinator } from "../../server/run-recovery.js";
import { TOOL_TEXT_CONTINUE_PROMPT } from "../../server/tool-text.js";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

function fixture() {
	const manager = SessionManager.inMemory("/fixture");
	let timestamp = 0;
	manager.appendMessage({ role: "user", content: "Complete the investigation", timestamp: ++timestamp });
	let messages = manager.buildSessionContext().messages;
	const flags = { current: true, admitted: true, idle: true, writable: true };
	const steering: string[] = [], followUp: string[] = [];
	const requests: { messages: AgentSession["messages"]; content: string }[] = [];
	const release = vi.fn();
	const session = {
		sessionManager: manager,
		get messages() { return messages; },
		get isIdle() { return flags.idle; },
		getSteeringMessages: () => steering,
		getFollowUpMessages: () => followUp,
		refreshContext: vi.fn(() => { messages = manager.buildSessionContext().messages; }),
		sendCustomMessage: vi.fn<AgentSession["sendCustomMessage"]>(async message => {
			requests.push({ messages: [...messages], content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) });
			manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			messages = manager.buildSessionContext().messages;
		}),
	} satisfies Pick<AgentSession, "sessionManager" | "messages" | "isIdle" | "getSteeringMessages" | "getFollowUpMessages" | "refreshContext" | "sendCustomMessage">;
	const host = {
		current: () => flags.current,
		admitted: () => flags.admitted,
		changed: vi.fn(),
		interrupt: vi.fn(async () => { flags.idle = true; }),
		prepare: vi.fn(async () => release),
		verifyEdit: vi.fn(async () => {}),
		writable: () => flags.writable,
		toolText: vi.fn(async () => {}),
	};
	// The coordinator uses this explicit session boundary; real SessionManager
	// projection/persistence is retained so context isolation is not mocked away.
	const coordinator = new RunRecoveryCoordinator(session as unknown as AgentSession, host);
	function assistant(stopReason: AssistantMessage["stopReason"] = "length", content: AssistantMessage["content"] = [{ type: "text", text: "Completed the first part of the report." }]) {
		const message: AssistantMessage = {
			role: "assistant", content, api: "anthropic-messages", provider: "fixture", model: "fixture", stopReason, timestamp: ++timestamp,
			usage: { input: 1, output: 128000, cacheRead: 0, cacheWrite: 0, totalTokens: 128001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const id = manager.appendMessage(message);
		messages = manager.buildSessionContext().messages;
		coordinator.observe({ type: "message_start", message });
		return { message, id };
	}
	function repeat(message: AssistantMessage) {
		flags.idle = false;
		coordinator.observe({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Emit.\n".repeat(300), partial: message } });
	}
	async function settled(aborted = false) {
		flags.idle = true;
		coordinator.observe({ type: "agent_settled", aborted });
		await vi.runOnlyPendingTimersAsync();
	}
	function user(text = "A new request") {
		manager.appendMessage({ role: "user", content: text, timestamp: ++timestamp });
		messages = manager.buildSessionContext().messages;
	}
	return { coordinator, session, host, flags, manager, requests, release, steering, followUp, assistant, repeat, settled, user };
}

async function flushRecoveryTasks() {
	await vi.runAllTimersAsync();
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("RunRecoveryCoordinator", () => {
	it("continues length twice without replaying the original task, then stops", async () => {
		const f = fixture();
		for (let i = 0; i < 3; i++) { f.assistant(); await f.settled(); }
		expect(f.requests).toHaveLength(2);
		expect(f.session.sendCustomMessage).toHaveBeenLastCalledWith(expect.objectContaining({ customType: RUN_CONTINUATION, details: expect.objectContaining({ reason: "length", attempt: 2 }) }), { triggerTurn: true });
		expect(f.requests.every(request => !request.content.includes("Complete the investigation"))).toBe(true);
		expect(f.requests[1].messages.filter(message => message.role === "assistant")).toHaveLength(2);
		expect(f.coordinator.status).toMatchObject({ phase: "stopped", reason: "length", attempt: 2, detail: "exhausted" });
		expect(f.release).toHaveBeenCalledTimes(2);
	});

	it("does not start a continuation synchronously inside agent_settled", async () => {
		const f = fixture(); f.assistant();
		f.coordinator.observe({ type: "agent_settled", aborted: false });
		expect(f.session.sendCustomMessage).not.toHaveBeenCalled();
		await vi.runOnlyPendingTimersAsync();
		expect(f.session.sendCustomMessage).toHaveBeenCalledTimes(1);
	});

	it.each(["stop", "error", "aborted"] as const)("does not issue continuation for %s", async stopReason => {
		const f = fixture(); f.assistant(stopReason); await f.settled(stopReason === "aborted");
		expect(f.session.sendCustomMessage).not.toHaveBeenCalled();
	});

	it("continues when thinking consumes the output budget before any visible answer", async () => {
		const f = fixture(); f.assistant("length", [{ type: "thinking", thinking: "Still reasoning" }]); await f.settled();
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0].messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "length" });
		expect(f.coordinator.status).toMatchObject({ reason: "length", phase: "recovering", attempt: 1 });
	});

	it("stops instead of continuing when the SDK projection no longer retains the truncated thinking", async () => {
		const f = fixture(); f.assistant("length", [{ type: "thinking", thinking: "Still reasoning" }]);
		vi.spyOn(f.manager, "buildSessionProjection").mockReturnValue({ ...f.manager.buildSessionProjection(), messages: [] });
		await f.settled();
		expect(f.requests).toHaveLength(0);
		expect(f.coordinator.status).toMatchObject({ reason: "length", phase: "stopped", detail: "failed" });
	});

	it("marks a continuation that returns a provider error as failed without consuming another attempt", async () => {
		const f = fixture(); f.assistant("length", [{ type: "thinking", thinking: "Still reasoning" }]); await f.settled();
		expect(f.requests).toHaveLength(1);
		f.assistant("error", []); await f.settled();
		expect(f.requests).toHaveLength(1);
		expect(f.host.toolText).not.toHaveBeenCalled();
		expect(f.coordinator.status).toMatchObject({ reason: "length", phase: "stopped", detail: "failed", attempt: 1 });
	});

	it.each([
		{ content: [] },
		{ content: [{ type: "text", text: "...\n..." }] },
	] satisfies { content: AssistantMessage["content"] }[])("does not blindly continue length without text or thinking %#", async ({ content }) => {
		const f = fixture(); f.assistant("length", content); await f.settled();
		expect(f.session.sendCustomMessage).not.toHaveBeenCalled();
		expect(f.coordinator.status).toMatchObject({ detail: "empty", phase: "stopped" });
	});

	it("does not continue length containing an unresolved tool call", async () => {
		const f = fixture(); f.assistant("length", [{ type: "text", text: "Writing the report" }, { type: "toolCall", id: "call", name: "write", arguments: {} }]); await f.settled();
		expect(f.requests).toHaveLength(0);
		expect(f.coordinator.status?.detail).toBe("unsafe");
	});

	it.each([
		{ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false },
		{ type: "auto_retry_end", success: false, attempt: 2, finalError: "Gateway failed" },
	] satisfies AgentSessionEvent[])("does not stack host retries after a native recovery failure %#", async event => {
		const f = fixture(); f.assistant(); f.coordinator.observe(event); await f.settled();
		expect(f.requests).toHaveLength(0);
		expect(f.coordinator.status).toMatchObject({ phase: "stopped", detail: "failed" });
	});

	it("shares the total cap with tool-text reminders without treating them as a new request", async () => {
		const f = fixture();
		expect(f.coordinator.reserveToolText()).toBe(true);
		f.user(TOOL_TEXT_CONTINUE_PROMPT);
		for (let i = 0; i < 2; i++) { f.assistant(); await f.settled(); }
		const { message, id } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.repeat(message); await flushRecoveryTasks();
		expect(f.requests).toHaveLength(2);
		expect(f.coordinator.status).toMatchObject({ reason: "repetition", phase: "stopped", detail: "exhausted" });
		expect(f.manager.getEntries().some(entry => entry.type === "context_edit" && entry.targetId === id)).toBe(true);
		expect(f.coordinator.reserveToolText()).toBe(false);
		f.user(); f.assistant(); await f.settled();
		expect(f.requests).toHaveLength(3);
		expect(f.coordinator.status).toMatchObject({ reason: "length", attempt: 1 });
	});

	it("shares the total action cap with an invalid-budget fallback", async () => {
		const f = fixture();
		expect(f.coordinator.reserveAutomaticAction("invalid-budget")).toBe(true);
		expect(f.coordinator.reserveToolText()).toBe(true);
		f.assistant(); await f.settled();
		expect(f.requests).toHaveLength(1);
		f.assistant(); await f.settled();
		expect(f.requests).toHaveLength(1);
		expect(f.coordinator.status).toMatchObject({ reason: "length", phase: "stopped", detail: "exhausted", attempt: 1 });
		expect(f.coordinator.reserveAutomaticAction("invalid-budget")).toBe(false);
	});

	it("restores counts and status without automatically running after reopen", async () => {
		const f = fixture(); f.assistant(); await f.settled();
		const restored = new RunRecoveryCoordinator(f.session as unknown as AgentSession, f.host);
		await vi.runOnlyPendingTimersAsync();
		expect(f.requests).toHaveLength(1);
		expect(restored.status).toMatchObject({ phase: "stopped", detail: "cancelled", attempt: 1 });
		f.assistant();
		restored.observe({ type: "agent_settled", aborted: false });
		await vi.runOnlyPendingTimersAsync();
		expect(f.requests).toHaveLength(2);
		expect(restored.status?.attempt).toBe(2);
	});

	it.each(["queue", "new-user", "cancel", "not-current", "not-admitted"] as const)("does not start scheduled length recovery after %s", async change => {
		const f = fixture(); f.assistant(); f.coordinator.observe({ type: "agent_settled", aborted: false });
		if (change === "queue") f.followUp.push("Please inspect this instead");
		if (change === "new-user") f.user();
		if (change === "cancel") f.coordinator.cancel(true);
		if (change === "not-current") f.flags.current = false;
		if (change === "not-admitted") f.flags.admitted = false;
		await vi.runOnlyPendingTimersAsync();
		expect(f.requests).toHaveLength(0);
	});

	it("revalidates cancellation after async model admission and releases the lease", async () => {
		const f = fixture(), waiting = deferred();
		f.host.prepare.mockImplementation(async () => { await waiting.promise; return f.release; });
		f.assistant(); await f.settled();
		expect(f.host.prepare).toHaveBeenCalledTimes(1);
		f.coordinator.cancel(true); waiting.resolve(); await flushRecoveryTasks();
		expect(f.requests).toHaveLength(0);
		expect(f.release).toHaveBeenCalledTimes(1);
	});

	it("does not attach an old admission failure to a new user task", async () => {
		const f = fixture(), waiting = deferred();
		f.host.prepare.mockImplementation(async () => { await waiting.promise; return f.release; });
		f.assistant(); await f.settled();
		f.coordinator.cancel(); f.user(); f.assistant("stop");
		waiting.reject(new Error("Old model admission failed")); await flushRecoveryTasks();
		expect(f.requests).toHaveLength(0);
		expect(f.coordinator.status).toBeUndefined();
	});

	it("waits for interrupted output to persist before isolating, preserving completed tools", async () => {
		const f = fixture(), waiting = deferred();
		f.assistant("toolUse", [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "report.md" } }]);
		f.manager.appendMessage({ role: "toolResult", toolCallId: "write-1", toolName: "write", content: [{ type: "text", text: "Report saved" }], isError: false, timestamp: 100 });
		const { message, id } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.host.interrupt.mockImplementation(async () => { await waiting.promise; f.flags.idle = true; });
		f.repeat(message);
		expect(f.session.refreshContext).not.toHaveBeenCalled();
		expect(f.requests).toHaveLength(0);
		waiting.resolve(); await flushRecoveryTasks();
		expect(f.session.refreshContext).toHaveBeenCalledTimes(1);
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0].messages.some(item => item.role === "assistant" && item.timestamp === message.timestamp)).toBe(false);
		expect(f.requests[0].messages.some(item => item.role === "toolResult" && item.toolCallId === "write-1")).toBe(true);
		expect(f.requests[0].messages.some(item => item.role === "assistant" && item.content.some(block => block.type === "toolCall" && block.id === "write-1"))).toBe(true);
		expect(f.manager.getEntry(id)?.type).toBe("message");
		expect(f.manager.buildSessionContext().messages.some(item => item.role === "assistant" && item.timestamp === message.timestamp)).toBe(false);
	});

	it("isolates a second repetition but never automatically retries it again", async () => {
		const f = fixture();
		for (let i = 0; i < 2; i++) {
			const { message } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
			f.repeat(message); await flushRecoveryTasks();
		}
		expect(f.host.interrupt).toHaveBeenCalledTimes(2);
		expect(f.session.refreshContext).toHaveBeenCalledTimes(2);
		expect(f.requests).toHaveLength(1);
		expect(f.coordinator.status).toMatchObject({ reason: "repetition", attempt: 1, phase: "stopped", detail: "exhausted" });
	});

	it("can interrupt an immediate repeated response from the recovery run", async () => {
		const f = fixture();
		f.session.sendCustomMessage.mockImplementationOnce(async () => {
			// A local provider can start emitting before the promise that triggered
			// its run resolves. The coordinator must not hold its scheduling lock.
			await Promise.resolve();
			const next = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
			f.repeat(next.message);
		});
		const { message } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.repeat(message); await flushRecoveryTasks();
		expect(f.host.interrupt).toHaveBeenCalledTimes(2);
		expect(f.session.sendCustomMessage).toHaveBeenCalledTimes(1);
	});

	it("quarantines repetition that finishes before deferred interruption without aborting an idle session", async () => {
		const f = fixture();
		const { message, id } = f.assistant("stop", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.repeat(message);
		f.flags.idle = true;
		f.coordinator.observe({ type: "agent_settled", aborted: false });
		await flushRecoveryTasks();
		expect(f.host.interrupt).not.toHaveBeenCalled();
		expect(f.manager.getEntries().some(entry => entry.type === "context_edit" && entry.targetId === id)).toBe(true);
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0].messages.some(item => item.role === "assistant" && item.timestamp === message.timestamp)).toBe(false);
	});

	it("does not interrupt a newer assistant response when cancellation wins before the deferred stop", async () => {
		const f = fixture();
		const old = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.repeat(old.message);
		f.coordinator.cancel();
		const next = f.assistant("pending", [{ type: "text", text: "A useful new response" }]);
		await flushRecoveryTasks();
		expect(f.host.interrupt).not.toHaveBeenCalled();
		expect(f.session.refreshContext).not.toHaveBeenCalled();
		expect(f.requests).toHaveLength(0);
		expect(f.session.messages.some(item => item.role === "assistant" && item.timestamp === next.message.timestamp)).toBe(true);
	});

	it.each(["interrupt", "verifyEdit"] as const)("does not quarantine an old response if a newer assistant starts during %s", async boundary => {
		const f = fixture(), waiting = deferred();
		const old = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.host[boundary].mockImplementation(async () => { await waiting.promise; f.flags.idle = true; });
		f.repeat(old.message); await flushRecoveryTasks();
		expect(f.host[boundary]).toHaveBeenCalledTimes(1);
		f.coordinator.cancel(false, true);
		const next = f.assistant("stop", [{ type: "text", text: "A useful new response" }]);
		waiting.resolve(); await flushRecoveryTasks();
		expect(f.manager.getEntries().some(entry => entry.type === "context_edit" && entry.targetId === old.id)).toBe(false);
		expect(f.session.refreshContext).not.toHaveBeenCalled();
		expect(f.requests).toHaveLength(0);
		expect(f.session.messages.some(item => item.role === "assistant" && item.timestamp === next.message.timestamp)).toBe(true);
	});

	it.each(["deferred-stop", "interrupt", "verifyEdit"] as const)("invalidates quarantine on lifecycle cancellation during %s even if the branch retains the same assistant", async boundary => {
		const f = fixture(), waiting = deferred();
		const old = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		if (boundary !== "deferred-stop") f.host[boundary].mockImplementation(async () => { await waiting.promise; f.flags.idle = true; });
		f.repeat(old.message);
		if (boundary !== "deferred-stop") {
			await flushRecoveryTasks();
			expect(f.host[boundary]).toHaveBeenCalledTimes(1);
		}
		f.coordinator.cancel();
		waiting.resolve(); await flushRecoveryTasks();
		if (boundary === "deferred-stop") expect(f.host.interrupt).not.toHaveBeenCalled();
		expect(f.manager.getEntries().some(entry => entry.type === "context_edit" && entry.targetId === old.id)).toBe(false);
		expect(f.session.refreshContext).not.toHaveBeenCalled();
		expect(f.requests).toHaveLength(0);
	});

	it("settles the incident if its branch changes while admission is pending", async () => {
		const f = fixture(), waiting = deferred();
		f.host.prepare.mockImplementation(async () => { await waiting.promise; return f.release; });
		const { message } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.repeat(message); await flushRecoveryTasks();
		f.manager.appendCustomEntry("external-entry", {});
		waiting.resolve(); await flushRecoveryTasks();
		expect(f.requests).toHaveLength(0);
		expect(f.release).toHaveBeenCalledTimes(1);
		expect(f.coordinator.status).toMatchObject({ phase: "stopped", detail: "cancelled" });
	});

	it("user stop during repetition still isolates the failed reply but cancels restart", async () => {
		const f = fixture(), waiting = deferred();
		const { message, id } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.host.interrupt.mockImplementation(async () => { await waiting.promise; f.flags.idle = true; });
		f.repeat(message); f.coordinator.cancel(true); waiting.resolve(); await flushRecoveryTasks();
		expect(f.requests).toHaveLength(0);
		expect(f.manager.getEntries().some(entry => entry.type === "context_edit" && entry.targetId === id)).toBe(true);
		expect(f.coordinator.status).toMatchObject({ phase: "stopped", detail: "cancelled" });
	});

	it("does not isolate or restart against a different user request after interruption", async () => {
		const f = fixture(), waiting = deferred();
		const { message } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.host.interrupt.mockImplementation(async () => { await waiting.promise; f.flags.idle = true; });
		f.repeat(message); f.user(); waiting.resolve(); await flushRecoveryTasks();
		expect(f.requests).toHaveLength(0);
		expect(f.session.refreshContext).not.toHaveBeenCalled();
	});

	it("does not edit model context when transcript verification rejects an external modification", async () => {
		const f = fixture();
		const { message, id } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.host.verifyEdit.mockRejectedValue(new Error("Session file modified externally"));
		f.repeat(message); await flushRecoveryTasks();
		expect(f.host.interrupt).toHaveBeenCalledTimes(1);
		expect(f.host.verifyEdit).toHaveBeenCalledTimes(1);
		expect(f.session.refreshContext).not.toHaveBeenCalled();
		expect(f.manager.getEntries().some(entry => entry.type === "context_edit" && entry.targetId === id)).toBe(false);
		expect(f.requests).toHaveLength(0);
		expect(f.coordinator.status).toMatchObject({ phase: "stopped", detail: "failed" });
		expect(f.coordinator.pending).toBe(false);
	});

	it("does not edit the old branch when a new user task starts during transcript verification", async () => {
		const f = fixture(), waiting = deferred();
		const { message, id } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.host.verifyEdit.mockImplementation(() => waiting.promise);
		f.repeat(message); await flushRecoveryTasks();
		expect(f.host.verifyEdit).toHaveBeenCalledTimes(1);
		f.coordinator.cancel(); f.user(); f.assistant("stop");
		waiting.resolve(); await flushRecoveryTasks();
		expect(f.session.refreshContext).not.toHaveBeenCalled();
		expect(f.manager.getEntries().some(entry => entry.type === "context_edit" && entry.targetId === id)).toBe(false);
		expect(f.requests).toHaveLength(0);
		expect(f.coordinator.status).toBeUndefined();
	});

	it.each(["before", "after"] as const)("quarantines repeated output when a prompt is queued %s detection without consuming that queue", async timing => {
		const f = fixture();
		const { message, id } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		// deliverAcceptedPrompt cancels pending host continuations before the
		// native SDK accepts a follow-up. The old stream can still be generating.
		if (timing === "after") f.repeat(message);
		f.coordinator.cancel(false, true);
		f.followUp.push("Please investigate a different file next");
		if (timing === "before") f.repeat(message);
		await flushRecoveryTasks();
		expect(f.host.interrupt).toHaveBeenCalledTimes(1);
		expect(f.manager.getEntries().some(entry => entry.type === "context_edit" && entry.targetId === id)).toBe(true);
		expect(f.session.messages.some(item => item.role === "assistant" && item.timestamp === message.timestamp)).toBe(false);
		expect(f.requests).toHaveLength(0);
		expect(f.followUp).toEqual(["Please investigate a different file next"]);
		expect(f.coordinator.status).toMatchObject({ phase: "stopped", detail: "cancelled" });
	});

	it("re-enables repeated-output detection for the current stream when protection is turned back on", async () => {
		const f = fixture();
		const { message } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.coordinator.setProtection(false);
		f.coordinator.setProtection(true);
		f.repeat(message); await flushRecoveryTasks();
		expect(f.host.interrupt).toHaveBeenCalledTimes(1);
	});

	it("only stops repeated messages with structural tool calls, without dropping their pairing", async () => {
		const f = fixture();
		const { message } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }, { type: "toolCall", id: "ambiguous", name: "write", arguments: {} }]);
		f.repeat(message); await flushRecoveryTasks();
		expect(f.host.interrupt).toHaveBeenCalledTimes(1);
		expect(f.requests).toHaveLength(0);
		expect(f.session.refreshContext).not.toHaveBeenCalled();
		expect(f.coordinator.status?.detail).toBe("unsafe");
	});

	it("restores disabled protection and does not interrupt deliberate repeated output", async () => {
		const f = fixture(); f.coordinator.setProtection(false);
		const restored = new RunRecoveryCoordinator(f.session as unknown as AgentSession, f.host);
		expect(restored.protection).toBe(false);
		const { message } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		f.repeat(message); await flushRecoveryTasks();
		expect(f.host.interrupt).not.toHaveBeenCalled();
	});

	it("disabling repetition protection preserves a pending normal length continuation", async () => {
		const f = fixture(); f.assistant();
		f.coordinator.observe({ type: "agent_settled", aborted: false });
		f.coordinator.setProtection(false);
		await flushRecoveryTasks();
		expect(f.coordinator.protection).toBe(false);
		expect(f.requests).toHaveLength(1);
		expect(f.coordinator.status).toMatchObject({ reason: "length", phase: "recovering", attempt: 1 });
	});

	it("does not mutate previously persisted recovery counts when later attempts are reserved", async () => {
		const f = fixture(); f.assistant(); await f.settled();
		const first = f.manager.getEntries().find(entry => entry.type === "custom" && entry.customType === RUN_RECOVERY_ENTRY);
		expect(first).toMatchObject({ data: { counts: { length: 1, repetition: 0, "tool-text": 0 } } });
		const original = JSON.stringify(first);
		f.assistant(); await f.settled();
		expect(f.coordinator.reserveToolText()).toBe(true);
		expect(JSON.stringify(first)).toBe(original);
		expect(f.manager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === RUN_RECOVERY_ENTRY)).toMatchObject({ data: { counts: { length: 2, repetition: 0, "tool-text": 1 } } });
	});

	it("keeps stopping and verification-failure status in memory when the transcript is not writable", async () => {
		const f = fixture();
		const { message } = f.assistant("aborted", [{ type: "text", text: "Emit.\n".repeat(300) }]);
		const writes = vi.spyOn(f.manager, "appendCustomEntry");
		const original = JSON.stringify(f.manager.getEntries());
		f.flags.writable = false;
		f.host.verifyEdit.mockRejectedValue(new Error("External modification"));
		f.repeat(message);
		expect(writes).not.toHaveBeenCalled();
		await flushRecoveryTasks();
		f.coordinator.setProtection(false);
		expect(writes).not.toHaveBeenCalled();
		expect(JSON.stringify(f.manager.getEntries())).toBe(original);
		expect(f.coordinator.protection).toBe(true);
		expect(f.coordinator.status).toMatchObject({ phase: "stopped", detail: "failed" });
		expect(f.requests).toHaveLength(0);
	});
});
