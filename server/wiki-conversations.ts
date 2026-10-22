import { statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WikiChatStore } from "./wiki-chat-store.js";
import { wikiPath } from "./wiki-service.js";

/** Internal runtime seam: ClientSession implements it without copying SDK state. */
export interface WikiConversationClient {
	readonly cwd: string;
	readonly switchingWorkspace: boolean;
	readonly conversationId: string;
	readonly activeIsWiki: boolean;
	readonly connected: boolean;
	readonly wikiChats: WikiChatStore;
	readonly session: { sessionManager: SessionManager; isStreaming: boolean; messages: readonly unknown[] };
	wikiDocumentSession(path: string): SessionManager | undefined;
	wikiSessionBusy(id: string): boolean;
	ownsWikiSession(id: string): boolean;
	newChat(fresh: boolean, wiki: boolean, manager?: SessionManager): Promise<boolean>;
	retireWikiSession(id: string): Promise<void>;
	flushSnapshot(): void;
}
interface WikiRuntimeRegistry {
	clients: ReadonlyMap<string, WikiConversationClient>;
	quiesced(): boolean;
	release(clientId: string): Promise<void>;
}
export interface WikiConversationRequest {
	action: string;
	conversationId?: unknown;
	path?: unknown;
	id?: unknown;
	title?: unknown;
	references?: unknown;
}

/** Owns admission, document/history selection and runtime/persistence ordering. */
export class WikiConversations {
	private operations = new Set<string>();
	constructor(private readonly registry: WikiRuntimeRegistry) {}

	private async prepare(id: string, requester: string): Promise<void> {
		for (const [clientId, client] of this.registry.clients) {
			if (clientId === requester || !client.ownsWikiSession(id)) continue;
			if (client.connected || client.wikiSessionBusy(id)) throw new Error("Wiki conversation is open in another window");
			await this.registry.release(clientId);
		}
	}

	async execute(clientId: string, cwd: string, request: WikiConversationRequest): Promise<unknown> {
		const client = this.registry.clients.get(clientId);
		if (!client || client.switchingWorkspace || client.cwd !== cwd) throw new Error("Workspace unavailable");
		const { action, conversationId, path, id } = request;
		const store = client.wikiChats;
		const session = client.session;
		const sessionId = session.sessionManager.getSessionId();
		const assertWorkspace = () => {
			if (this.registry.clients.get(clientId) !== client || client.switchingWorkspace || client.cwd !== cwd) throw new Error("Workspace changed");
		};
		const assertSource = () => {
			assertWorkspace();
			if (client.session !== session || client.conversationId !== conversationId) throw new Error("Conversation changed");
			if (this.registry.quiesced()) throw new Error("Conversation unavailable");
			if (session.isStreaming && (action !== "new-conversation" || client.activeIsWiki)) throw new Error("Wait for the current request to finish");
		};
		if (action === "chat-list") return (await store.list(cwd)).filter(item => !path || item.documentPath === path);
		if (action === "chat-context") {
			if (!client.activeIsWiki || conversationId !== client.conversationId) throw new Error("Conversation changed");
			client.flushSnapshot();
			return { sessionId, isStreaming: session.isStreaming, references: store.settings(cwd, sessionId).references };
		}
		if (conversationId !== client.conversationId || this.registry.quiesced()) throw new Error("Conversation unavailable");
		// Real workspace aliases share one admission slot; overlapping requests fail rather than queue.
		const key = store.directory(cwd);
		if (this.operations.has(key)) throw new Error("Wiki conversation operation in progress");
		this.operations.add(key);
		try {
			if (action === "chat-references" || action === "chat-validate-references") {
				if (!client.activeIsWiki) throw new Error("Not a Wiki conversation");
				const references = store.validateReferences(cwd, request.references);
				if (action === "chat-references") store.update(cwd, sessionId, { references });
				return { sessionId, references };
			}
			assertSource();
			if (action === "new-conversation") {
				// Legacy entry also accepts media, and leaves a running normal chat alone.
				if (path !== undefined && path !== null) {
					if (typeof path !== "string") throw new Error("Invalid path");
					if (!statSync(wikiPath(cwd, path)).isFile()) throw new Error("Not a file");
				}
				if (!await client.newChat(true, true)) throw new Error("Could not create conversation");
				assertWorkspace();
				if (!client.activeIsWiki || client.conversationId === conversationId) throw new Error("Could not create conversation");
				return this.current(client);
			}
			if (action === "chat-document") {
				const documentPath = store.validateReferences(cwd, [path])[0];
				const live = client.wikiDocumentSession(documentPath);
				const saved = (await store.list(cwd)).find(item => item.documentPath === documentPath);
				assertSource();
				const targetId = live?.getSessionId() ?? saved?.id;
				if (targetId) await this.prepare(targetId, clientId);
				assertSource();
				if (targetId !== sessionId) {
					const manager = live ?? (saved ? SessionManager.open(store.file(cwd, saved.id), store.directory(cwd)) : undefined);
					const blank = client.activeIsWiki && !store.settings(cwd, sessionId).documentPath && session.messages.length === 0;
					if ((manager || !blank) && !await client.newChat(true, true, manager)) throw new Error("Could not open document conversation");
				}
				assertWorkspace();
				if (!client.activeIsWiki || (targetId && client.session.sessionManager.getSessionId() !== targetId)) throw new Error("Conversation changed");
				const result = this.current(client);
				store.update(cwd, result.sessionId, { documentPath, references: [], opened: Date.now() });
				return result;
			}
			if (!["chat-resume", "chat-open", "chat-new", "chat-rename", "chat-delete"].includes(action)) throw new Error("Unknown Wiki chat action");
			const target = action === "chat-resume" ? (await store.list(cwd))[0]?.id : id;
			assertSource();
			if (target !== undefined && typeof target !== "string") throw new Error("Invalid Wiki session");
			if (target && action === "chat-open" && path && store.settings(cwd, target).documentPath !== path) throw new Error("Document conversation mismatch");
			// Validate bindings before switching or deleting any runtime/history.
			const documentPath = typeof path === "string" && path ? store.validateReferences(cwd, [path])[0] : undefined;
			if (target) await this.prepare(target, clientId);
			assertSource();
			if (action === "chat-rename") {
				if (!target || typeof request.title !== "string" || !request.title.trim() || request.title.length > 120) throw new Error("Invalid title");
				store.file(cwd, target);
				store.update(cwd, target, { title: request.title.trim() });
				return { ok: true };
			}
			if (action === "chat-delete") {
				if (!target) throw new Error("Invalid Wiki session");
				store.file(cwd, target);
				if (client.wikiSessionBusy(target)) throw new Error("Wiki conversation has running tasks or terminals");
				if (sessionId === target && !await client.newChat(true, true)) throw new Error("Could not create conversation");
				assertWorkspace();
				await client.retireWikiSession(target);
				assertWorkspace();
				store.remove(cwd, target);
			} else {
				if (action === "chat-open" && !target) throw new Error("Invalid Wiki session");
				if (action === "chat-new" || (target && target !== sessionId) || !client.activeIsWiki) {
					const manager = target ? SessionManager.open(store.file(cwd, target), store.directory(cwd)) : undefined;
					if (!await client.newChat(true, true, manager)) throw new Error("Could not open conversation");
				}
			}
			assertWorkspace();
			const result = this.current(client);
			store.update(cwd, result.sessionId, { opened: Date.now(), ...(documentPath ? { documentPath } : {}) });
			return { ...result, references: store.settings(cwd, result.sessionId).references };
		} finally {
			this.operations.delete(key);
		}
	}

	private current(client: WikiConversationClient) {
		return { conversationId: client.conversationId, sessionId: client.session.sessionManager.getSessionId() };
	}
}
