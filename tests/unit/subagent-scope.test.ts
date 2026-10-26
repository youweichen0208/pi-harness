import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager, SettingsManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { deliverPrompt, recallPending } from "../../server/prompt-delivery.js";
import { createSubagentPromptScope, getSubagentWorkspace } from "../../server/subagents/scope.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "subagent-scope-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const services = await createAgentSessionServices({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(), resourceLoaderOptions: { extensionFactories: [{ name: "scope-input", factory: pi => {
		pi.on("input", event => ({ action: "transform", text: `transformed: ${event.text}` }));
	} }] } });
	const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root) });
	cleanups.push(() => session.dispose());
	await session.bindExtensions({});
	const subscribe = session.subscribe.bind(session);
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const subscription = vi.spyOn(session, "subscribe").mockImplementation(listener => {
		listeners.add(listener);
		const off = subscribe(listener);
		return () => { listeners.delete(listener); off(); };
	});
	const emit = (event: AgentSessionEvent) => { for (const listener of listeners) listener(event); };
	const user = (text: string) => emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
	const streaming = vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
	return { session, emit, user, subscription, listeners, streaming };
}

test("queued work keeps the active scope until the native transformed user message is consumed", async () => {
	const { session, emit, user } = await fixture();
	createSubagentPromptScope(session.sessionManager).started("active");
	await deliverPrompt(session, "question", [], true, () => {}, "queued");
	expect(getSubagentWorkspace(session.sessionManager)).toBe("active");
	expect(session.getFollowUpMessages()).toEqual(["transformed: question"]);
	// The SDK removes queue text before delivering message_start.
	emit({ type: "queue_update", steering: [], followUp: [] });
	expect(getSubagentWorkspace(session.sessionManager)).toBe("active");
	user("transformed: question");
	expect(getSubagentWorkspace(session.sessionManager)).toBe("queued");
});

test("identical queued prompts consume steering first and preserve insertion order within each lane", async () => {
	const { session, user } = await fixture();
	createSubagentPromptScope(session.sessionManager).started("active");
	await deliverPrompt(session, "same", [], true, () => {}, "follow");
	await deliverPrompt(session, "same", [], false, () => {}, "steer-first");
	await deliverPrompt(session, "same", [], false, () => {}, "steer-second");
	await deliverPrompt(session, "clear", [], true, () => {});
	for (const expected of ["steer-first", "steer-second", "follow"]) {
		user("transformed: same");
		expect(getSubagentWorkspace(session.sessionManager)).toBe(expected);
	}
	user("transformed: clear");
	expect(getSubagentWorkspace(session.sessionManager)).toBeUndefined();
});

test("an identical prompt queued during run preparation cannot consume the initial request scope", async () => {
	const { session, emit, user } = await fixture();
	vi.spyOn(session, "prompt").mockImplementationOnce(async (text, options) => {
		// The original run is awaiting before_agent_start; a second request is
		// accepted by the real SDK queue before the first run reaches started.
		await deliverPrompt(session, text, [], false, () => {}, "queued");
		const accepted = session.getSteeringMessages()[0];
		options?.preflightResult?.("started");
		emit({ type: "queue_update", steering: [], followUp: [] });
		user(accepted);
		expect(getSubagentWorkspace(session.sessionManager)).toBe("initial");
		user(accepted);
		expect(getSubagentWorkspace(session.sessionManager)).toBe("queued");
	});
	await deliverPrompt(session, "same", [], false, () => {}, "initial");
	// After the initial user event, another accepted prompt consumes normally.
	await deliverPrompt(session, "later", [], true, () => {}, "later");
	expect(getSubagentWorkspace(session.sessionManager)).toBe("queued");
	user("transformed: later");
	expect(getSubagentWorkspace(session.sessionManager)).toBe("later");
});

test("recall removes pending scope without changing the active request and sessions stay isolated", async () => {
	const first = await fixture(), second = await fixture();
	createSubagentPromptScope(first.session.sessionManager).started("one");
	createSubagentPromptScope(second.session.sessionManager).started("two");
	await deliverPrompt(first.session, "same", [], true, () => {}, "one-next");
	await deliverPrompt(second.session, "same", [], true, () => {}, "two-next");
	expect(recallPending(first.session).followUp).toEqual(["transformed: same"]);
	first.user("transformed: same");
	second.user("transformed: same");
	expect(getSubagentWorkspace(first.session.sessionManager)).toBe("one");
	expect(getSubagentWorkspace(second.session.sessionManager)).toBe("two-next");
});

test("started preflight binds and clears scope without changing prompt text or installing repeated listeners", async () => {
	const { session, emit, subscription, listeners } = await fixture();
	const prompt = vi.spyOn(session, "prompt").mockImplementation(async (_text, options) => { options?.preflightResult?.("started"); });
	await deliverPrompt(session, "first", [], false, () => {}, "workspace");
	expect(getSubagentWorkspace(session.sessionManager)).toBe("workspace");
	await deliverPrompt(session, "next", [], false, () => {});
	expect(getSubagentWorkspace(session.sessionManager)).toBeUndefined();
	expect(prompt.mock.calls.map(([text]) => text)).toEqual(["first", "next"]);
	expect(subscription).toHaveBeenCalledTimes(1);
	emit({ type: "agent_settled", aborted: false });
	expect(listeners.size).toBe(0);
	await session.reload();
	await deliverPrompt(session, "after reload", [], false, () => {}, "new");
	expect(subscription).toHaveBeenCalledTimes(2);
	expect(listeners.size).toBe(1);
	expect(getSubagentWorkspace(session.sessionManager)).toBe("new");
	emit({ type: "agent_settled", aborted: true });
	expect(listeners.size).toBe(0);
});

test("settling discards unconsumed scopes and reusing a manager for another session cannot inherit selection", async () => {
	const { session, emit, user } = await fixture();
	const manager = session.sessionManager;
	createSubagentPromptScope(manager).started("active");
	await deliverPrompt(session, "unconsumed", [], true, () => {}, "pending");
	emit({ type: "agent_settled", aborted: true });
	user("transformed: unconsumed");
	expect(getSubagentWorkspace(manager)).toBe("active");
	manager.newSession();
	expect(getSubagentWorkspace(manager)).toBeUndefined();
});
