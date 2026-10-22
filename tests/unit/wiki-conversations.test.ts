import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WikiConversations, type WikiConversationClient, type WikiConversationRequest } from "../../server/wiki-conversations.js";
import { WikiChatStore } from "../../server/wiki-chat-store.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(yes => { resolve = yes; });
	return { promise, resolve };
}
/** Controlled runtime adapter; persistence and SessionManager are real, no model is started. */
class Runtime implements WikiConversationClient {
	switchingWorkspace = false;
	conversationId = "conv-0";
	activeIsWiki = true;
	connected = true;
	terminals = new Set<string>();
	retired: string[] = [];
	managers = new Map<string, SessionManager>();
	session: WikiConversationClient["session"];
	failOpen = false;
	flushSnapshot = vi.fn();
	constructor(public cwd: string, readonly wikiChats: WikiChatStore) {
		this.session = { sessionManager: SessionManager.create(cwd, wikiChats.directory(cwd)), isStreaming: false, messages: [] };
	}
	wikiDocumentSession(path: string) {
		return [this.session.sessionManager, ...this.managers.values()].find(manager => this.wikiChats.settings(this.cwd, manager.getSessionId()).documentPath === path);
	}
	wikiSessionBusy(id: string) { return this.terminals.has(id) || (this.session.sessionManager.getSessionId() === id && this.session.isStreaming); }
	ownsWikiSession(id: string) { return this.session.sessionManager.getSessionId() === id || this.managers.has(id); }
	async newChat(_fresh: boolean, _wiki: boolean, manager?: SessionManager) {
		if (this.failOpen) return false;
		this.managers.set(this.session.sessionManager.getSessionId(), this.session.sessionManager);
		this.session = { sessionManager: manager ?? SessionManager.create(this.cwd, this.wikiChats.directory(this.cwd)), isStreaming: false, messages: [] };
		this.conversationId = `conv-${this.managers.size}`;
		this.activeIsWiki = true;
		return true;
	}
	async retireWikiSession(id: string) {
		if (this.wikiSessionBusy(id) || this.session.sessionManager.getSessionId() === id) throw new Error("Cannot retire");
		this.managers.delete(id); this.retired.push(id);
	}
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "wiki-conversations-")); roots.push(root);
	const cwd = join(root, "workspace"); mkdirSync(cwd);
	for (const path of ["a.md", "b.md"]) writeFileSync(join(cwd, path), `# ${path}`);
	const store = new WikiChatStore(join(root, "wiki"));
	const client = new Runtime(cwd, store);
	const clients = new Map<string, Runtime>([["first", client]]);
	let quiesced = false;
	const release = vi.fn(async (id: string) => { clients.delete(id); });
	const conversations = new WikiConversations({ clients, release, quiesced: () => quiesced });
	const execute = (request: WikiConversationRequest, clientId = "first") => conversations.execute(clientId, cwd, { conversationId: clients.get(clientId)?.conversationId, ...request });
	return { root, cwd, store, client, clients, release, conversations, execute, quiesce: () => { quiesced = true; } };
}
function persist(manager: SessionManager) {
	manager.appendMessage({ role: "user", content: "Question", timestamp: Date.now() });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Answer" }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
}

it("binds the initial blank chat, restores blank document chats and clears references", async () => {
	const f = fixture(); const original = f.client.session.sessionManager.getSessionId();
	expect(await f.execute({ action: "chat-document", path: "./a.md" })).toMatchObject({ sessionId: original });
	await f.execute({ action: "chat-references", references: ["b.md"] });
	await f.execute({ action: "chat-document", path: "b.md" });
	expect(f.client.session.sessionManager.getSessionId()).not.toBe(original);
	expect(await f.execute({ action: "chat-document", path: "a.md" })).toMatchObject({ sessionId: original });
	expect(await f.execute({ action: "chat-context" })).toMatchObject({ references: [], sessionId: original });
	expect(await f.execute({ action: "chat-list" })).toEqual([]);
});

it("restores persisted per-document history after losing all runtimes", async () => {
	const f = fixture(); await f.execute({ action: "chat-document", path: "a.md" });
	const id = f.client.session.sessionManager.getSessionId(); persist(f.client.session.sessionManager);
	f.clients.set("first", new Runtime(f.cwd, new WikiChatStore(join(f.root, "wiki"))));
	expect(await f.execute({ action: "chat-document", path: "a.md" })).toMatchObject({ sessionId: id });
	expect(await f.execute({ action: "chat-list", path: "a.md" })).toMatchObject([{ id }]);
	expect(await f.execute({ action: "chat-list", path: "b.md" })).toEqual([]);
});

it("refuses a connected owner and a disconnected busy owner, then releases an idle owner", async () => {
	const f = fixture(); await f.execute({ action: "chat-document", path: "a.md" });
	const id = f.client.session.sessionManager.getSessionId(); persist(f.client.session.sessionManager);
	f.clients.set("second", new Runtime(f.cwd, f.store));
	await expect(f.execute({ action: "chat-document", path: "a.md" }, "second")).rejects.toThrow(/another window/);
	f.client.connected = false; f.client.terminals.add(id);
	await expect(f.execute({ action: "chat-open", id }, "second")).rejects.toThrow(/another window/);
	f.client.terminals.clear();
	expect(await f.execute({ action: "chat-open", id }, "second")).toMatchObject({ sessionId: id });
	expect(f.release).toHaveBeenCalledWith("first");
});

it("rejects concurrent operations and releases admission after a failure", async () => {
	const f = fixture(), wait = deferred();
	vi.spyOn(f.store, "list").mockImplementationOnce(async () => { await wait.promise; throw new Error("read failed"); });
	const opening = f.execute({ action: "chat-document", path: "a.md" });
	const failed = expect(opening).rejects.toThrow("read failed");
	await expect(f.execute({ action: "new-conversation" })).rejects.toThrow(/in progress/);
	wait.resolve(); await failed;
	await expect(f.execute({ action: "chat-document", path: "a.md" })).resolves.toMatchObject({ conversationId: "conv-0" });
});

it.each(["workspace", "session", "streaming", "quiesce", "client"])("rechecks %s after awaiting history before opening", async change => {
	const f = fixture(), wait = deferred();
	vi.spyOn(f.store, "list").mockImplementationOnce(async () => { await wait.promise; return []; });
	const opening = f.execute({ action: "chat-document", path: "a.md" });
	const failed = expect(opening).rejects.toThrow();
	if (change === "workspace") f.client.switchingWorkspace = true;
	if (change === "session") await f.client.newChat(true, true);
	if (change === "streaming") f.client.session.isStreaming = true;
	if (change === "quiesce") f.quiesce();
	if (change === "client") f.clients.delete("first");
	wait.resolve(); await failed;
	expect(f.store.settings(f.cwd, f.client.session.sessionManager.getSessionId()).documentPath).toBeUndefined();
});

it("does not bind or delete history when replacement fails", async () => {
	const f = fixture(); await f.execute({ action: "chat-document", path: "a.md" });
	const original = f.client.session.sessionManager; persist(original); f.client.failOpen = true;
	await expect(f.execute({ action: "chat-document", path: "b.md" })).rejects.toThrow(/Could not open/);
	expect(f.client.session.sessionManager).toBe(original);
	expect(f.store.settings(f.cwd, original.getSessionId()).documentPath).toBe("a.md");
	await expect(f.execute({ action: "chat-delete", id: original.getSessionId() })).rejects.toThrow(/Could not create/);
	expect(existsSync(f.store.file(f.cwd, original.getSessionId()))).toBe(true);
});

it("protects busy history and retires an idle active runtime before removing only its transcript", async () => {
	const f = fixture(); await f.execute({ action: "chat-document", path: "a.md" });
	const original = f.client.session.sessionManager; persist(original); const id = original.getSessionId();
	f.client.terminals.add(id);
	await expect(f.execute({ action: "chat-delete", id })).rejects.toThrow(/running tasks or terminals/);
	f.client.terminals.clear();
	await f.execute({ action: "chat-delete", id });
	expect(f.client.retired).toEqual([id]);
	expect(f.client.session.sessionManager.getSessionId()).not.toBe(id);
	expect(await f.store.list(f.cwd)).toEqual([]);
	expect(existsSync(join(f.cwd, "a.md"))).toBe(true);
});

it("keeps history when retiring the runtime fails", async () => {
	const f = fixture(); persist(f.client.session.sessionManager);
	const id = f.client.session.sessionManager.getSessionId();
	vi.spyOn(f.client, "retireWikiSession").mockRejectedValueOnce(new Error("retirement failed"));
	await expect(f.execute({ action: "chat-delete", id })).rejects.toThrow("retirement failed");
	expect(existsSync(f.store.file(f.cwd, id))).toBe(true);
});

it("validates bindings before opening and preserves rename/resume/reference behavior", async () => {
	const f = fixture(); await f.execute({ action: "chat-document", path: "a.md" });
	persist(f.client.session.sessionManager); const id = f.client.session.sessionManager.getSessionId();
	await expect(f.execute({ action: "chat-open", id, path: "b.md" })).rejects.toThrow(/mismatch/);
	await expect(f.execute({ action: "chat-new", path: "../escape.md" })).rejects.toThrow();
	expect(f.client.session.sessionManager.getSessionId()).toBe(id);
	await f.execute({ action: "chat-rename", id, title: " Renamed " });
	expect(await f.execute({ action: "chat-list" })).toMatchObject([{ id, title: "Renamed" }]);
	await f.execute({ action: "chat-new" });
	expect(await f.execute({ action: "chat-resume" })).toMatchObject({ sessionId: id });
	await f.execute({ action: "chat-references", references: ["b.md"] });
	expect(await f.execute({ action: "chat-validate-references", references: ["a.md"] })).toMatchObject({ references: ["a.md"] });
	expect(await f.execute({ action: "chat-context" })).toMatchObject({ references: ["b.md"] });
});

it("allows legacy entry from streaming normal chat but never from streaming Wiki", async () => {
	const f = fixture(); f.client.session.isStreaming = true;
	await expect(f.execute({ action: "new-conversation" })).rejects.toThrow(/current request/);
	f.client.activeIsWiki = false;
	await expect(f.execute({ action: "new-conversation" })).resolves.toMatchObject({ conversationId: "conv-1" });
});
