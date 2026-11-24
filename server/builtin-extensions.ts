import { desktopGrant, desktopSupported } from "./desktop-control.js";
import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { nativeExtensionRegistry } from "./native-tools.js";
import { getDocumentSettings, updateDocumentSettings } from "./document-extension-settings.js";
import type { BuiltinExtensionId, BuiltinExtensionsState, BuiltinExtensionState } from "./protocol.js";

const expectedTools: Partial<Record<BuiltinExtensionId, string[]>> = {
	codemode: ["codemode"], "tool-search": ["tool_search"],
};
const owns = (path: string, id: string) => path === `<inline:${id}>` || path === `builtin:${id}`;
function documentSettingsVersion(): string {
	return createHash("sha256").update(JSON.stringify(getDocumentSettings())).digest("hex");
}
export function toggleBuiltinDocument(id: unknown, enabled: unknown, version: unknown): void {
	if (id !== "background-bash" || typeof enabled !== "boolean") throw Error("Invalid built-in extension change");
	if (version !== documentSettingsVersion()) throw Error("Document settings changed; refresh and retry");
	updateDocumentSettings({ backgroundEnabled: enabled });
}

/** Inventory reads existing session resources; it never runs factories or reloads. */
export function builtinExtensionsState(session: AgentSession, conversationId: string, canReload: boolean, wiki = false): BuiltinExtensionsState {
	const resources = session.resourceLoader.getExtensions();
	const tools = session.getAllTools();
	// Codemode itself is active for the model but deliberately not nested-callable.
	const callable = new Set([...session.getCallableToolNames(), ...session.getActiveToolNames()]);
	let documentSettings: ReturnType<typeof getDocumentSettings> | undefined, documentError: string | undefined, documentVersion: string | undefined;
	try { documentSettings = getDocumentSettings(); documentVersion = documentSettingsVersion(); }
	catch (error) { documentError = error instanceof Error ? error.message : String(error); }
	const items = nativeExtensionRegistry.map(({ name }): BuiltinExtensionState => {
		const id = name;
		const extension = resources.extensions.find(extension => owns(extension.path, id));
		const ownedTools = tools.filter(tool => owns(tool.sourceInfo.path, id));
		const expected = expectedTools[id] ?? [];
		const conflict = expected.some(name => tools.some(tool => tool.name === name && !owns(tool.sourceInfo.path, id)));
		const failure = resources.errors.find(error => owns(error.path, id));
		const item: BuiltinExtensionState = { id, status: "loaded", tools: ownedTools.map(tool => tool.name), commands: extension ? [...extension.commands.keys()] : [] };
		if (failure) return { ...item, status: "error", error: failure.error };
		if (conflict || !extension || expected.some(name => !ownedTools.some(tool => tool.name === name))) return { ...item, status: "unavailable", reason: conflict ? "conflict" : "missing" };
		if (item.enabled === false) return { ...item, status: "disabled" };
		if (item.enabled && ownedTools.some(tool => tool.exposure === "hidden")) return { ...item, status: "pending" };
		if (expected.some(name => !callable.has(name))) return { ...item, status: "disabled", reason: "filtered" };
		return item;
	});
	if (!wiki) {
		const loaded = tools.some(tool => tool.name === "bash_task" && owns(tool.sourceInfo.path, "background-bash"));
		const enabled = documentSettings?.backgroundEnabled;
		const conflict = enabled && !loaded && resources.extensions.some(ext => ext.tools.has("bash") || ext.tools.has("bash_task"));
		items.push({ id: "background-bash", enabled, error: documentError, status: documentError ? "error" : conflict ? "unavailable" : loaded !== enabled ? "pending" : loaded ? "loaded" : "disabled", reason: conflict ? "conflict" : undefined, tools: loaded ? ["bash", "bash_task"] : [], commands: [] });
	}
	if (!wiki && desktopSupported()) {
		const grant = desktopGrant(session.sessionManager);
		const enabled = !!grant.controller;
		items.push({id: "desktop-control", enabled, status: enabled ? "loaded" : "disabled", settingsVersion: grant.version, commands: [], tools: ["desktop_window"]});
	}
	return { conversationId, items, documentVersion, canReload };
}
