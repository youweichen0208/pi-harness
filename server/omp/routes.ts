import { realpathSync, statSync } from "node:fs";
import type { UiOmpPath } from "../protocol.js";
import type { Express, Request } from "express";
import type { OmpChatService } from "./chat-service.js";
import { isRecord } from "./framing.js";

/** Native OMP resources replace Pi's built-in extension catalogue. */
export function installOmpRoutes(app: Express, service: () => OmpChatService, allowed: (request: Request) => boolean) {
	app.post("/api/omp-paths", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		const { clientId, cwd, conversationId, target, prepare } = req.body ?? {};
		const host = service(), client = typeof clientId === "string" ? host.get(clientId) : undefined;
		const valid = () => client && host.get(clientId) === client && client.cwd === cwd && client.conversationId === conversationId && !client.switchingWorkspace;
		if (!valid()) { res.status(409).json({ error: "OMP_PATH_OWNER_CHANGED" }); return; }
		try {
			if (!isRecord(target) || prepare !== undefined && typeof prepare !== "boolean") throw Error("Invalid path request");
			let path: string | undefined, kind: UiOmpPath["kind"] = "directory";
			if (target.kind === "extensions") path = client!.extensionDirectory(prepare === true);
			else if (target.kind === "module" && typeof target.id === "string") {
				const state = await client!.nativeExtensions({ action: "get" });
				const module = Array.isArray(state.modules) ? state.modules.find(item => isRecord(item) && item.id === target.id) : undefined;
				path = isRecord(module) && typeof module.path === "string" ? module.path : undefined; kind = "file";
			} else if (target.kind === "package" && typeof target.name === "string") {
				path = (await host.packages.list(cwd)).items.find(item => item.name === target.name)?.path;
			} else if (target.kind === "plugin" && typeof target.id === "string" && typeof target.path === "string" && ["user", "project"].includes(String(target.scope))) {
				const plugin = (await host.packages.list(cwd)).marketplace?.installed.find(item => item.id === target.id && item.scope === target.scope);
				if (plugin?.paths.includes(target.path)) path = target.path;
			}
			if (!valid()) { res.status(409).json({ error: "OMP_PATH_OWNER_CHANGED" }); return; }
			if (!path) throw Error("Path unavailable");
			let exists = true;
			try {
				const stat = statSync(path);
				if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) throw Error("Invalid path type");
				path = realpathSync(path);
			} catch (error) {
				if (target.kind !== "extensions" || prepare === true || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				exists = false;
			}
			res.json({ absolute: path, kind, exists } satisfies UiOmpPath);
		} catch { res.status(400).json({ error: "OMP_PATH_UNAVAILABLE" }); }
	});

	app.post("/api/omp-packages", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		const { clientId, cwd, conversationId, action, operation, target, id, plan, scope, selectedFeatures, expectedVersion, settingsScope, patch } = req.body ?? {};
		const host = service(), client = typeof clientId === "string" ? host.get(clientId) : undefined;
		if (!client || client.cwd !== cwd || client.conversationId !== conversationId || client.switchingWorkspace) { res.status(409).json({ error: "Conversation unavailable" }); return; }
		const owner = { clientId, cwd, conversationId };
		try {
			if (action === "list") res.json({ ...(await host.packages.list(cwd)), jobs: host.packages.jobs(owner) });
			else if (action === "settings-read" || action === "settings-save") {
				if (action === "settings-save" && (host.isQuiesced() || client.session.state.running || !isRecord(patch))) throw Error("Stop the current task before changing package settings");
				const readOrWrite = () => host.packages.settings(cwd, target, scope, settingsScope, action === "settings-save" ? patch : undefined, expectedVersion);
				const data = action === "settings-save" ? await client.changePackageSettings(readOrWrite) : await readOrWrite();
				if (client.cwd !== cwd || client.conversationId !== conversationId || client.switchingWorkspace) throw Error("Conversation changed");
				res.json(data);
			}
			else if (action === "preview") res.json(await host.packages.preview(cwd, operation, target, scope, selectedFeatures, expectedVersion));
			else if (action === "job" && typeof id === "string") res.json(host.packages.get(owner, id));
			else if (action === "cancel" && typeof id === "string") res.json(await host.packages.cancel(owner, id));
			else if (action === "start" && typeof id === "string") {
				if (host.isQuiesced() || client.session.state.running) throw Error("Stop the current task before changing packages");
				res.json(host.packages.start(owner, id, plan));
			} else throw Error("Invalid package action");
		} catch (error) { res.status(400).json({ error: (error as Error).message }); }
	});
	app.post("/api/omp-extensions", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		const { clientId, cwd, conversationId, action, version, patch, moduleId, enabled, content } = req.body ?? {};
		const client = typeof clientId === "string" ? service().get(clientId) : undefined;
		if (!client || client.cwd !== cwd || client.conversationId !== conversationId || client.switchingWorkspace) { res.status(409).json({ error: "Conversation unavailable" }); return; }
		try { res.json(await client.nativeExtensions({ action, version, patch, moduleId, enabled, content })); }
		catch (error) { res.status(400).json({ error: (error as Error).message }); }
	});
	app.post("/api/omp-mcp", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		const { clientId, cwd, conversationId, action, scope, version, document, name, authId, value } = req.body ?? {};
		const client = typeof clientId === "string" ? service().get(clientId) : undefined;
		if (!client || client.cwd !== cwd || client.conversationId !== conversationId || client.switchingWorkspace) { res.status(409).json({ error: "Conversation unavailable" }); return; }
		try { res.json(await client.nativeMcp({ action, scope, version, document, name, authId, value })); }
		catch (error) { res.status(400).json({ error: (error as Error).message }); }
	});
	app.post("/api/system-prompt", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		const { clientId, cwd, conversationId, action, fileId, version, content } = req.body ?? {};
		const client = typeof clientId === "string" ? service().get(clientId) : undefined;
		if (!client || client.cwd !== cwd || client.conversationId !== conversationId || client.switchingWorkspace) { res.status(409).json({ error: "Conversation unavailable" }); return; }
		try {
			res.json(await client.nativePrompt({ action, fileId, version, content }));
		} catch (error) { res.status(400).json({ error: (error as Error).message }); }
	});
	app.post("/api/extensions", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		const { clientId, cwd, conversationId, action } = req.body ?? {};
		const client = typeof clientId === "string" ? service().get(clientId) : undefined;
		if (!client || client.cwd !== cwd || client.switchingWorkspace || (conversationId && client.conversationId !== conversationId)) { res.status(409).json({ error: "Workspace unavailable" }); return; }
		try {
			if (action === "omp-resources" || action === "omp-reload" || action === "omp-save-skills") {
				if (client.conversationId !== conversationId) { res.status(409).json({ error: "Conversation unavailable" }); return; }
				res.json(await client.nativeResources(action, { version: req.body.version, patch: req.body.patch })); return;
			}
			res.status(410).json({ error: "This Pi extension operation has been retired; use the OMP resource and package settings" });
		} catch (error) { res.status(400).json({ error: (error as Error).message }); }
	});
}
