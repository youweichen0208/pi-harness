import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { nativeExtensionRegistry } from "./native-tools.js";
import { getDocumentSettings, updateDocumentSettings } from "./document-extension-settings.js";
import { subagentSettings, toggleSubagents } from "./subagents/settings.js";
import { subagentDefaultActive } from "./subagents/extension.js";
import { designFirstSettings, designFirstSkillPath, toggleDesignFirst } from "./design-first-resources.js";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { BuiltinExtensionId, BuiltinExtensionsState, BuiltinExtensionState } from "./protocol.js";

const expectedTools: Partial<Record<BuiltinExtensionId, string[]>> = {
	"pi-harness-database": ["database_read"],
	"pi-harness-subagents": ["subagent"],
	codemode: ["codemode"], "tool-search": ["tool_search"],
};
const owns = (path: string, id: string) => path === `<inline:${id}>` || path === `builtin:${id}`;
export function documentSettingsVersion(): string {
	return createHash("sha256").update(JSON.stringify(getDocumentSettings())).digest("hex");
}
export function toggleBuiltinDocument(id: unknown, enabled: unknown, version: unknown): void {
	if (id === "pi-harness-design-first" && typeof enabled === "boolean" && typeof version === "string") { toggleDesignFirst(enabled, version); return; }
	if (id === "pi-harness-subagents" && typeof enabled === "boolean" && typeof version === "string") { toggleSubagents(enabled, version); return; }
	if (id !== "pi-harness-database" || typeof enabled !== "boolean") throw Error("Invalid built-in extension change");
	if (version !== documentSettingsVersion()) throw Error("Document settings changed; refresh and retry");
	updateDocumentSettings({ databaseEnabled: enabled });
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
		if (id === "pi-harness-database") {
			if (!documentSettings) return { ...item, status: "error", error: documentError };
			item.enabled = documentSettings.databaseEnabled;
		}
		if (id === "pi-harness-subagents") {
			try { const settings = subagentSettings(); item.enabled = settings.enabled; item.settingsVersion = settings.version; }
			catch (error) { return { ...item, status: "error", error: String(error) }; }
		}
		if (conflict || !extension || expected.some(name => !ownedTools.some(tool => tool.name === name))) return { ...item, status: "unavailable", reason: conflict ? "conflict" : "missing" };
		if (item.enabled === false) return { ...item, status: "disabled" };
		if (id === "pi-harness-subagents" && !subagentDefaultActive(session.settingsManager.getSettings().defaultTools)) return { ...item, status: "disabled", reason: "filtered" };
		if (item.enabled && ownedTools.some(tool => tool.exposure === "hidden")) return { ...item, status: "pending" };
		if (expected.some(name => !callable.has(name))) return { ...item, status: "disabled", reason: "filtered" };
		return item;
	});
	const design: BuiltinExtensionState = { id: "pi-harness-design-first", status: "unavailable", tools: [], commands: [] };
	try {
		const config = designFirstSettings(), path = designFirstSkillPath();
		design.enabled = config.enabled; design.settingsVersion = config.version;
		const skill = session.resourceLoader.getSkills().skills.find(skill => skill.name === "design-first");
		const loaded = !!skill && resolve(skill.filePath) === resolve(path);
		// Native extension commands run before prompt templates and skill expansion.
		const extensionCommands = new Set(session.extensionRunner.getRegisteredCommands().map(command => command.invocationName));
		if (loaded && !extensionCommands.has("skill:design-first")) design.commands = ["skill:design-first"];
		for (const name of ["bug-fix", "feat"]) {
			const prompt = session.promptTemplates.find(prompt => prompt.name === name);
			if (prompt && !extensionCommands.has(name) && resolve(prompt.filePath) === resolve(dirname(path), "commands", `${name}.md`)) design.commands.push(name);
		}
		if (wiki) { design.reason = "filtered"; }
		else if (!existsSync(path)) { design.reason = "missing"; }
		else if ((skill && !loaded) || extensionCommands.has("skill:design-first")) { design.reason = "conflict"; }
		else design.status = config.enabled ? loaded ? "loaded" : "pending" : loaded ? "pending" : "disabled";
	} catch (error) { design.status = "error"; design.error = String(error); }
	items.push(design);
	return { conversationId, items, documentVersion, canReload };
}
