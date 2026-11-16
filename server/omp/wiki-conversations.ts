import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { writeFileAtomic } from "../private-file.js";
import { wikiPath } from "../wiki-service.js";
import { isWikiDocumentPath } from "../wiki-links.js";
import type { OmpChatService } from "./chat-service.js";

type Meta = { title?: string; documentPath?: string; references: string[]; opened?: number };
/** Document bindings stay host-owned; OMP alone reads and writes transcripts. */
export class OmpWikiConversations {
	private pending = new Set<string>();
	constructor(private readonly service: OmpChatService, private readonly dataDir: string) {}
	private file(cwd: string, id: string) {
		if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Error("Invalid Wiki session");
		const directory = join(this.dataDir, "omp", "wiki", createHash("sha256").update(realpathSync(cwd)).digest("hex"));
		mkdirSync(directory, { recursive: true, mode: 0o700 }); return join(directory, `${id}.json`);
	}
	private meta(cwd: string, id: string): Meta {
		try { return JSON.parse(readFileSync(this.file(cwd, id), "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { references: [] }; }
	}
	private update(cwd: string, id: string, patch: Partial<Meta>) { writeFileAtomic(this.file(cwd, id), JSON.stringify({ ...this.meta(cwd, id), ...patch })); }
	private references(cwd: string, paths: unknown) {
		if (!Array.isArray(paths) || paths.length > 100 || paths.some(path => typeof path !== "string" || !isWikiDocumentPath(path))) throw Error("Invalid document selection");
		return [...new Set(paths.map(path => {
			const file = wikiPath(cwd, path); if (!statSync(file).isFile()) throw Error("Document unavailable");
			return relative(realpathSync(cwd), realpathSync(file)).split(sep).join("/");
		}))];
	}
	async execute(clientId: string, cwd: string, request: { action: string; conversationId?: unknown; path?: unknown; id?: unknown; title?: unknown; references?: unknown }) {
		const client = this.service.get(clientId);
		if (!client || client.cwd !== cwd || client.switchingWorkspace) throw Error("Workspace unavailable");
		const current = () => ({ conversationId: client.conversationId, sessionId: client.session.state.sessionId! });
		const initial = current();
		const { action, path, id } = request;
		if (action === "chat-context") {
			if (!client.activeIsWiki || request.conversationId !== initial.conversationId) throw Error("Conversation changed");
			client.flushSnapshot(); return { ...initial, isStreaming: client.session.isStreaming, references: this.meta(cwd, initial.sessionId).references };
		}
		if (action === "chat-list") {
			if (!client.activeIsWiki) throw Error("Open a Wiki window first");
			return (await client.nativeSessions()).filter(session => session.messageCount > 0).map(session => {
				const meta = this.meta(cwd, session.id);
				return { id: session.id, title: meta.title || session.name || session.firstMessage.slice(0, 80), updated: Math.max(session.modified, meta.opened ?? 0), references: meta.references, documentPath: meta.documentPath };
			}).filter(session => !path || session.documentPath === path).sort((a, b) => b.updated - a.updated);
		}
		if (request.conversationId !== initial.conversationId || this.service.isQuiesced()) throw Error("Conversation unavailable");
		const key = realpathSync(cwd);
		if (this.pending.has(key)) throw Error("Wiki conversation operation in progress");
		this.pending.add(key);
		try {
			if (action === "chat-references" || action === "chat-validate-references") {
				if (!client.activeIsWiki) throw Error("Not a Wiki conversation");
				const references = this.references(cwd, request.references);
				if (action === "chat-references") this.update(cwd, initial.sessionId, { references });
				return { sessionId: initial.sessionId, references };
			}
			if (client.session.isStreaming && (action !== "new-conversation" || client.activeIsWiki)) throw Error("Wait for the current request to finish");
			// Validate before creating a native session, including the compatibility entry.
			const documentPath = typeof path === "string" && path ? this.references(cwd, [path])[0] : undefined;
			if (action === "new-conversation") { await client.newChat(true, true); return current(); }
			if (!client.activeIsWiki) throw Error("Open a Wiki window first");
			const sessions = await client.nativeSessions();
			if (client.conversationId !== initial.conversationId || client.cwd !== cwd) throw Error("Conversation changed");
			let target = action === "chat-resume" ? sessions[0] : sessions.find(session => session.id === id);
			if (action === "chat-document") {
				if (!documentPath) throw Error("Invalid document");
				target = sessions.find(session => this.meta(cwd, session.id).documentPath === documentPath);
			}
			if (target) await this.service.claimSession(clientId, target.id);
			if (action === "chat-rename") {
				if (!target || typeof request.title !== "string" || !request.title.trim() || request.title.length > 120) throw Error("Invalid title");
				this.update(cwd, target.id, { title: request.title.trim() }); return { ok: true };
			}
			if (action === "chat-delete") {
				if (!target) throw Error("Unknown Wiki session");
				await client.deleteSession(target.path, { replaceActive: true }); rmSync(this.file(cwd, target.id), { force: true });
			} else if (["chat-document", "chat-open", "chat-resume", "chat-new"].includes(action)) {
				if (action === "chat-open" && !target) throw Error("Unknown Wiki session");
				if (action === "chat-open" && documentPath && target && this.meta(cwd, target.id).documentPath !== documentPath) throw Error("Document conversation mismatch");
				if (action === "chat-new") await client.newChat(true, true);
				else if (target && target.id !== initial.sessionId) await client.switchSession(target.path);
				else if (!target && (client.session.state.messages.length || this.meta(cwd, initial.sessionId).documentPath)) await client.newChat(true, true);
			} else throw Error("Unknown Wiki operation");
			const next = current();
			this.update(cwd, next.sessionId, { opened: Date.now(), ...(documentPath ? { documentPath } : {}) });
			return { ...next, references: this.meta(cwd, next.sessionId).references };
		} finally { this.pending.delete(key); }
	}
}
