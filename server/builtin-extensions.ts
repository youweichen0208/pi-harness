import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { nativeExtensionRegistry } from "./native-tools.js";
import { getDocumentSettings, updateDocumentSettings } from "./document-extension-settings.js";
import { planSettings } from "./plan/settings.js";
import type { BuiltinExtensionId, BuiltinExtensionsState, BuiltinExtensionState } from "./protocol.js";

const documentKeys = { "pi-harness-okf": "okfEnabled" } as const;
const expectedTools: Partial<Record<BuiltinExtensionId, string[]>> = {
	"pi-harness-okf": ["okf_ingest", "okf_candidates", "okf_publish"],
	"pi-harness-plan": ["plan"], codemode: ["codemode"], "tool-search": ["tool_search"],
};
const owns = (path: string, id: string) => path === `<inline:${id}>` || path === `builtin:${id}`;
export function documentSettingsVersion(): string {
	return createHash("sha256").update(JSON.stringify(getDocumentSettings())).digest("hex");
}
export function toggleBuiltinDocument(id: unknown, enabled: unknown, version: unknown): void {
	if (id !== "pi-harness-okf" || typeof enabled !== "boolean") throw Error("Invalid built-in extension change");
	if (version !== documentSettingsVersion()) throw Error("Document settings changed; refresh and retry");
	updateDocumentSettings({ [documentKeys[id]]: enabled });
}

/** Inventory reads existing session resources; it never runs factories or reloads. */
export function builtinExtensionsState(session: AgentSession, conversationId: string, canReload: boolean): BuiltinExtensionsState {
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
		if (id === "pi-harness-plan") {
			const plan = planSettings().state(session);
			return { ...item, enabled: plan.enabled, status: !plan.available ? "unavailable" : plan.pending ? "pending" : plan.effective ? "loaded" : "disabled", reason: plan.reason };
		}
		if (id === "pi-harness-okf") {
			if (!documentSettings) return { ...item, status: "error", error: documentError };
			item.enabled = documentSettings[documentKeys[id]];
		}
		if (conflict || !extension || expected.some(name => !ownedTools.some(tool => tool.name === name))) return { ...item, status: "unavailable", reason: conflict ? "conflict" : "missing" };
		if (item.enabled === false) return { ...item, status: "disabled" };
		if (item.enabled && ownedTools.some(tool => tool.exposure === "hidden")) return { ...item, status: "pending" };
		if (expected.some(name => !callable.has(name))) return { ...item, status: "disabled", reason: "filtered" };
		return item;
	});
	return { conversationId, items, documentVersion, canReload };
}
