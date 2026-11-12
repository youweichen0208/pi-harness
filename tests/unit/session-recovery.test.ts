import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionRecovery } from "../../server/session-recovery.js";
import type { ServerMessage } from "../../server/protocol.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-recovery-unit-")); roots.push(root);
	const agent = join(root, "agent"), cwd = join(root, "current"), old = join(root, "old");
	mkdirSync(cwd); mkdirSync(old);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const source = SessionManager.create(old);
	source.appendMessage({ role: "user", content: "Restore me", timestamp: Date.now() });
	rmSync(old, { recursive: true });
	return { root, agent, cwd, old, source, path: source.getSessionFile()!, recovery: new SessionRecovery(agent) };
}

test("selection expires and binds the current conversation and target directory", async () => {
	const f = fixture(), [item] = await f.recovery.list("one", f.cwd);
	expect(f.recovery.validate(item.token, "one", f.cwd).path).toBe(f.path);
	expect(() => f.recovery.validate(item.token, "two", f.cwd)).toThrow(/失效/);
	expect(() => f.recovery.validate(item.token, "one", f.root)).toThrow(/失效/);
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
	expect(() => f.recovery.validate(item.token, "one", f.cwd)).toThrow(/失效/);
});

test("refresh invalidates previous selections and an available source directory cannot be recovered", async () => {
	const f = fixture(), [previous] = await f.recovery.list("one", f.cwd);
	const [current] = await f.recovery.list("one", f.cwd);
	expect(() => f.recovery.validate(previous.token, "one", f.cwd)).toThrow(/失效/);
	mkdirSync(f.old);
	expect(() => f.recovery.validate(current.token, "one", f.cwd)).toThrow(/已恢复/);
	expect(await f.recovery.list("one", f.cwd)).toEqual([]);
});

test.skipIf(process.platform === "win32")("discovery cannot recover a symlinked transcript outside the native sessions root", async () => {
	const f = fixture();
	const outside = SessionManager.create(f.old, join(f.root, "outside"));
	outside.appendMessage({ role: "user", content: "Outside", timestamp: Date.now() });
	const link = join(f.agent, "sessions", "linked"); mkdirSync(link);
	symlinkSync(outside.getSessionFile()!, join(link, "outside.jsonl"));
	const list = await f.recovery.list("one", f.cwd);
	expect(list).toHaveLength(1); expect(list[0].firstMessage).toBe("Restore me");
});

test("failure after native fork creation removes only that new copy and keeps the current conversation", async () => {
	const f = fixture();
	const { ClientSession } = await import("../../server/agent-service.js");
	const { ClientStateStore } = await import("../../server/client-state.js");
	const { ThinkingDurationStore } = await import("../../server/thinking-timing.js");
	const client = await ClientSession.create("recovery-failure", f.cwd, new ClientStateStore(join(f.root, "data", "clients.json")), new ThinkingDurationStore(join(f.root, "thinking.json")));
	const messages: ServerMessage[] = []; client.attachSink(message => messages.push(message));
	try {
		const conversationId = client.conversationId;
		await client.recoverMissingSession({ type: "list_missing_sessions", reqId: "list", conversationId });
		const list = messages.find(message => message.type === "missing_sessions");
		if (!list || list.type !== "missing_sessions") throw new Error("Missing recovery list");
		const before = readFileSync(f.path), files = readdirSync(join(f.agent, "sessions"), { recursive: true }).filter(path => path.toString().endsWith(".jsonl"));
		const nativeFork = SessionManager.forkFrom.bind(SessionManager);
		vi.spyOn(SessionManager, "forkFrom").mockImplementation((...args) => {
			const manager = nativeFork(...args);
			rmSync(f.cwd, { recursive: true }); // Directory disappears after copy, before runtime creation.
			return manager;
		});
		await client.recoverMissingSession({ type: "recover_missing_session", reqId: "recover", conversationId, token: list.sessions[0].token, action: "fork" });
		expect(messages.find(message => message.type === "missing_session_result")).toMatchObject({ status: "error" });
		expect(client.conversationId).toBe(conversationId);
		expect(readFileSync(f.path)).toEqual(before);
		expect(readdirSync(join(f.agent, "sessions"), { recursive: true }).filter(path => path.toString().endsWith(".jsonl"))).toEqual(files);
	} finally { mkdirSync(f.cwd, { recursive: true }); await client.dispose(); }
}, 15000);

test("extension binding failure rolls back the active conversation and deletes the unadopted fork", async () => {
	const f = fixture();
	const { ClientSession } = await import("../../server/agent-service.js");
	const { ClientStateStore } = await import("../../server/client-state.js");
	const { ThinkingDurationStore } = await import("../../server/thinking-timing.js");
	const client = await ClientSession.create("recovery-bind-failure", f.cwd, new ClientStateStore(join(f.root, "data", "clients.json")), new ThinkingDurationStore(join(f.root, "thinking.json")));
	const messages: ServerMessage[] = []; client.attachSink(message => messages.push(message));
	try {
		const conversationId = client.conversationId, runtime = client.runtime, before = readFileSync(f.path);
		await client.recoverMissingSession({ type: "list_missing_sessions", reqId: "list", conversationId });
		const list = messages.find(message => message.type === "missing_sessions");
		if (!list || list.type !== "missing_sessions") throw Error("Missing list");
		const files = readdirSync(join(f.agent, "sessions"), { recursive: true }).filter(path => path.toString().endsWith(".jsonl"));
		vi.spyOn(AgentSession.prototype, "bindExtensions").mockRejectedValueOnce(Error("extension binding failed"));
		await client.recoverMissingSession({ type: "recover_missing_session", reqId: "recover", conversationId, token: list.sessions[0].token, action: "fork" });
		expect(messages.find(message => message.type === "missing_session_result")).toMatchObject({ status: "error", error: "extension binding failed" });
		expect(client.conversationId).toBe(conversationId); expect(client.runtime).toBe(runtime); expect(client.cwd).toBe(f.cwd);
		expect(readFileSync(f.path)).toEqual(before);
		expect(readdirSync(join(f.agent, "sessions"), { recursive: true }).filter(path => path.toString().endsWith(".jsonl"))).toEqual(files);
		expect(await client.switchSession(join(f.root, "deleted.jsonl"))).toBe(false);
		expect(client.runtime).toBe(runtime);
	} finally { await client.dispose(); }
}, 15000);

test("Continue cannot reuse a live runtime still bound to the missing original directory", async () => {
	const f = fixture(); mkdirSync(f.old);
	const { ClientSession } = await import("../../server/agent-service.js");
	const { ClientStateStore } = await import("../../server/client-state.js");
	const { ThinkingDurationStore } = await import("../../server/thinking-timing.js");
	const client = await ClientSession.create("recovery-old-runtime", f.old, new ClientStateStore(join(f.root, "data", "clients.json")), new ThinkingDurationStore(join(f.root, "thinking.json")));
	const messages: ServerMessage[] = []; client.attachSink(message => messages.push(message));
	try {
		await client.setCwd(f.cwd);
		const conversationId = client.conversationId, runtime = client.runtime;
		rmSync(f.old, { recursive: true });
		await client.recoverMissingSession({ type: "list_missing_sessions", reqId: "list", conversationId });
		const list = messages.find(message => message.type === "missing_sessions");
		if (!list || list.type !== "missing_sessions") throw Error("Missing list");
		await client.recoverMissingSession({ type: "recover_missing_session", reqId: "recover", conversationId, token: list.sessions[0].token, action: "continue" });
		expect(messages.find(message => message.type === "missing_session_result")).toMatchObject({ status: "error", error: expect.stringContaining("复制到当前项目") });
		expect(client.conversationId).toBe(conversationId); expect(client.runtime).toBe(runtime); expect(client.cwd).toBe(f.cwd);
	} finally { await client.dispose(); }
}, 15000);
