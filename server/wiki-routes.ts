import type { Express, Request } from "express";
import type { AgentService } from "./agent-service.js";
import type { WikiConversationResult, ProjectWorkspaceCatalog } from "./protocol.js";
import { WikiService, WikiConflictError, wikiPath } from "./wiki-service.js";
import { statSync } from "node:fs";
import { extname, basename } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Wiki uses the same authenticated client and original SDK session as chat. */
export function installWikiRoutes(app: Express, service: () => AgentService, dataDir: string, originAllowed: (req: Request) => boolean, projects: () => ProjectWorkspaceCatalog) {
	const wiki = new WikiService(dataDir);
	const chatOperations = new Set<string>();
	app.post("/api/wiki", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!originAllowed(req) || !req.is("application/json")) { res.status(403).json({ error: "Forbidden" }); return; }
		const { clientId, cwd, action, path, query, text, version, id, undo, conversationId, requestId, offset } = req.body ?? {};
		if (![clientId, cwd, action].every(v => typeof v === "string")) { res.status(400).json({ error: "Invalid request" }); return; }
		const cs = service().get(clientId);
		if (!cs || cs.switchingWorkspace || cs.cwd !== cwd) { res.status(409).json({ error: "Workspace unavailable" }); return; }
		const session = cs.session;
		const valid = () => !cs.switchingWorkspace && cs.cwd === cwd && cs.session === session;
		try {
			let result: unknown;
			if (action.startsWith("chat-")) {
				const store = cs.wikiChats;
				const sessionId = session.sessionManager.getSessionId();
				if (action === "chat-list") { res.json((await store.list(cwd)).filter(item => !path || item.documentPath === path)); return; }
				if (action === "chat-context") {
					if (!cs.activeIsWiki || conversationId !== cs.conversationId) throw new Error("Conversation changed");
					res.json({ sessionId, references: store.settings(cwd, sessionId).references }); return;
				}
				if (action === "chat-projects") { res.json(projects()); return; }
				if (action === "chat-validate-project") {
					if (!cs.activeIsWiki || conversationId !== cs.conversationId) throw new Error("Conversation changed");
					const group = projects().workspaces.find(item => item.id === req.body.workspaceId);
					if (!group || typeof path !== "string" || !group.paths.includes(path) || !statSync(path).isDirectory()) throw new Error("Project unavailable");
					res.json({ workspaceId: group.id, workspaceName: group.name, path, name: basename(path) }); return;
				}
				if (conversationId !== cs.conversationId || service().quiesceInfo().quiesced) throw new Error("Conversation unavailable");
				const operationKey = store.directory(cwd);
				if (chatOperations.has(operationKey)) throw new Error("Wiki conversation operation in progress");
				chatOperations.add(operationKey);
				try {
					if (action === "chat-references" || action === "chat-validate-references") {
						if (!cs.activeIsWiki) throw new Error("Not a Wiki conversation");
						const references = store.validateReferences(cwd, req.body.references);
						for (const path of references) if (!statSync(wikiPath(cwd, path)).isFile()) throw new Error(`Document unavailable: ${path}`);
						if (action === "chat-references") store.update(cwd, sessionId, { references });
						res.json({ sessionId, references }); return;
					}
					if (session.isStreaming) throw new Error("Wait for the current request to finish");
					if (action === "chat-document") {
						const documentPath = store.validateReferences(cwd, [path])[0];
						const live = cs.wikiDocumentSession(documentPath);
						const saved = (await store.list(cwd)).find(item => item.documentPath === documentPath);
						if (!valid()) throw new Error("Conversation changed");
						const targetId = live?.getSessionId() ?? saved?.id;
						if (targetId) await service().prepareWikiSession(cwd, targetId, clientId);
						if (!valid()) throw new Error("Conversation changed");
						if (targetId !== sessionId) {
							const manager = live ?? (saved ? SessionManager.open(store.file(cwd, saved.id), store.directory(cwd)) : undefined);
							const blank = cs.activeIsWiki && !store.settings(cwd, sessionId).documentPath && session.messages.length === 0;
							if ((manager || !blank) && !await cs.newChat(true, true, manager)) throw new Error("Could not open document conversation");
						}
						const currentId = cs.session.sessionManager.getSessionId();
						store.update(cwd, currentId, { documentPath, references: [], opened: Date.now() });
						res.json({ conversationId: cs.conversationId, sessionId: currentId }); return;
					}
					let target = id;
					if (action === "chat-resume") target = (await store.list(cwd))[0]?.id;
					if (!valid()) throw new Error("Conversation changed");
					if (target !== undefined && typeof target !== "string") throw new Error("Invalid Wiki session");
					if (target && action === "chat-open" && path && store.settings(cwd, target).documentPath !== path) throw new Error("Document conversation mismatch");
					if (target) await service().prepareWikiSession(cwd, target, clientId);
					if (!valid()) throw new Error("Conversation changed");
					if (action === "chat-rename") {
						if (!target || typeof req.body.title !== "string" || !req.body.title.trim() || req.body.title.length > 120) throw new Error("Invalid title");
						store.file(cwd, target); store.update(cwd, target, { title: req.body.title.trim() }); res.json({ ok: true }); return;
					}
					if (action === "chat-delete") {
						if (!target) throw new Error("Invalid Wiki session");
						store.file(cwd, target);
						if (cs.wikiSessionBusy(target)) throw new Error("Wiki conversation has running tasks or terminals");
						if (sessionId === target && !await cs.newChat(true, true)) throw new Error("Could not create conversation");
						await cs.retireWikiSession(target);
						store.remove(cwd, target);
					} else if (["chat-open", "chat-resume", "chat-new"].includes(action)) {
						if (action === "chat-open" && !target) throw new Error("Invalid Wiki session");
						if (action === "chat-new" || (target && target !== sessionId) || !cs.activeIsWiki) {
							const manager = target ? SessionManager.open(store.file(cwd, target), store.directory(cwd)) : undefined;
							if (!await cs.newChat(true, true, manager)) throw new Error("Could not open conversation");
						}
					} else throw new Error("Unknown Wiki chat action");
					if (cs.cwd !== cwd || cs.switchingWorkspace) throw new Error("Workspace changed");
					const currentId = cs.session.sessionManager.getSessionId();
					store.update(cwd, currentId, { opened: Date.now(), ...(typeof path === "string" && path ? { documentPath: store.validateReferences(cwd, [path])[0] } : {}) });
					res.json({ conversationId: cs.conversationId, sessionId: currentId, references: store.settings(cwd, currentId).references }); return;
				} finally { chatOperations.delete(operationKey); }
			}
			switch (action) {
				case "new-conversation": {
					if (conversationId !== cs.conversationId || service().quiesceInfo().quiesced) throw new Error("Conversation unavailable");
					// Interrupting a running request is an explicit user decision made in
					// the browser (confirm → abort → wait for settle); the route itself
					// refuses to silently strand a streaming Wiki conversation as a
					// zombie. Entering Wiki mode from a streaming NORMAL conversation
					// stays allowed — it keeps running in the background.
					if (cs.activeIsWiki && session.isStreaming) throw new Error("Wait for the current request to finish");
					// The path is optional: entering Wiki mode from the top bar without a
					// document creates a blank conversation; opening a document validates it.
					if (path !== undefined && path !== null) {
						if (typeof path !== "string") throw new Error("Invalid path");
						if (!statSync(wikiPath(cwd, path)).isFile()) throw new Error("Not a file");
					}
					if (!valid()) throw new Error("Conversation changed");
					if (!await cs.newChat(true, true)) throw new Error("Could not create conversation");
					if (cs.cwd !== cwd || cs.switchingWorkspace || cs.conversationId === conversationId) throw new Error("Could not create conversation");
					res.json({ conversationId: cs.conversationId, sessionId: cs.session.sessionManager.getSessionId() } satisfies WikiConversationResult); return;
				}
				case "open-info": { if (typeof path !== "string") throw new Error("Invalid path"); const absolute = wikiPath(cwd, path); if (!statSync(absolute).isFile()) throw new Error("Not a file"); result = { absolute }; break; }
				case "state": result = await wiki.state(cwd); break;
				case "directory": if (typeof path !== "string") throw new Error("Invalid path"); result = await wiki.directory(cwd, path, offset); break;
				case "document-content": if (typeof path !== "string") throw new Error("Invalid path"); result = await wiki.documentContent(cwd, path); break;
				case "document-references": if (typeof path !== "string") throw new Error("Invalid path"); result = await wiki.documentReferences(cwd, path); break;
				case "document": if (typeof path !== "string") throw new Error("Invalid path"); result = await wiki.document(cwd, path); break;
				case "change": if (typeof path !== "string" || typeof id !== "string") throw new Error("Invalid change"); result = wiki.change(cwd, id, path); break;
				case "search": if (typeof query !== "string") throw new Error("Invalid query"); result = await wiki.search(cwd, query); break;
				case "refresh": wiki.invalidate(cwd); result = await wiki.state(cwd, true); break;
				case "write":
					if (service().quiesceInfo().quiesced || session.isStreaming) throw new Error("Wait for the current request to finish");
					if (![path, text, version].every(v => typeof v === "string")) throw new Error("Invalid save request");
					wiki.write(cwd, path, text, version); result = await wiki.documentContent(cwd, path); break;
				case "create-file":
					if (service().quiesceInfo().quiesced || session.isStreaming) throw new Error("Wait for the current request to finish");
					if (typeof path !== "string" || conversationId !== cs.conversationId) throw new Error("Invalid create request");
					result = wiki.createFile(cwd, path); break;
				case "restore":
					if (service().quiesceInfo().quiesced || session.isStreaming) throw new Error("Wait for the current request to finish");
					if (typeof id !== "string" || typeof undo !== "boolean" || (path !== undefined && typeof path !== "string")) throw new Error("Invalid undo request");
					wiki.restore(cwd, id, undo, path); result = await wiki.state(cwd); break;
				case "prompt": {
					if (service().quiesceInfo().quiesced || session.isStreaming) throw new Error("Wait for the current request to finish");
					if (typeof text !== "string" || !text.trim() || text.length > 100000 || typeof requestId !== "string" || conversationId !== cs.conversationId) throw new Error("Invalid Wiki request");
					const before = await wiki.begin(cwd);
					if (!valid() || session.isStreaming) { wiki.cancel(cwd); throw new Error("Conversation changed"); }
					const messageCount = session.messages.length;
					let settled = false;
					const finish = () => { if (settled) return; settled = true; off(); void wiki.finish(cwd, before, text, { conversationId, sessionId: session.sessionManager.getSessionId(), requestId, assistantTimestamp: session.messages.slice(messageCount).findLast(message => message.role === "assistant")?.timestamp }).catch(e => console.error(`Wiki history failed: ${e.message}`)); };
					const off = session.subscribe(event => { if (event.type === "agent_settled") finish(); });
					await new Promise<void>((resolve, reject) => {
						void cs.prompt(text, undefined, false, requestId, ok => ok ? resolve() : reject(new Error("Pi rejected the request; check model configuration"))).finally(() => { finish(); resolve(); });
					});
					result = { accepted: true }; break;
				}
				default: throw new Error("Unknown Wiki action");
			}
			if (cs.switchingWorkspace || cs.cwd !== cwd || (["prompt", "write", "restore", "create-file"].includes(action) && !valid())) { res.status(409).json({ error: "Workspace changed" }); return; }
			res.json(result);
		} catch (error) { res.status(error instanceof WikiConflictError ? 409 : 400).json({ error: (error as Error).message, ...(error instanceof WikiConflictError ? { code: "version_conflict" } : {}) }); }
	});
	app.get("/api/wiki-media", (req, res) => {
		try {
			if (!originAllowed(req)) { res.sendStatus(403); return; }
			const { clientId, cwd, path } = req.query;
			if (![clientId, cwd, path].every(v => typeof v === "string")) { res.sendStatus(400); return; }
			const cs = service().get(clientId as string);
			if (!cs || cs.switchingWorkspace || cs.cwd !== cwd) { res.sendStatus(409); return; }
			const absolute = wikiPath(cwd as string, path as string);
			if (!statSync(absolute).isFile()) { res.sendStatus(404); return; }
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("X-Content-Type-Options", "nosniff");
			if (req.query.download === "1") res.download(absolute);
			else if ([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg"].includes(extname(absolute).toLowerCase())) {
				res.setHeader("Content-Security-Policy", "sandbox"); res.sendFile(absolute);
			} else res.sendStatus(400);
		} catch { res.sendStatus(404); }
	});
}
