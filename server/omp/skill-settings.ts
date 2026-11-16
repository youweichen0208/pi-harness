/** Bun-only: persist skill preferences through OMP's public settings registry. */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import * as native from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { createHash } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { UiOmpSkillSettings, OmpSkillSettingKey, OmpSkillSettingValue } from "../protocol.js";
import { isRecord } from "./framing.js";

const definitions = {
	enabled: native.cfgSkillsEnabled,
	enableSkillCommands: native.cfgSkillsEnableSkillCommands,
	enableCodexUser: native.cfgSkillsEnableCodexUser,
	enableClaudeUser: native.cfgSkillsEnableClaudeUser,
	enableClaudeProject: native.cfgSkillsEnableClaudeProject,
	enablePiUser: native.cfgSkillsEnablePiUser,
	enablePiProject: native.cfgSkillsEnablePiProject,
	enableAgentsUser: native.cfgSkillsEnableAgentsUser,
	enableAgentsProject: native.cfgSkillsEnableAgentsProject,
	customDirectories: native.cfgSkillsCustomDirectories,
	ignoredSkills: native.cfgSkillsIgnoredSkills,
	manualSkills: native.cfgSkillsManualSkills,
	includeSkills: native.cfgSkillsIncludeSkills,
};

export class SkillSettingsError extends Error {}

export function skillSettingsView(session: AgentSession): UiOmpSkillSettings {
	const global = session.settings.getGlobalSettings().skills;
	const entries = (Object.keys(definitions) as OmpSkillSettingKey[]).map(key => {
		const definition = definitions[key];
		const saved = isRecord(global) ? global[key] : undefined;
		return { key, value: definition.get(session.settings), global: saved === undefined || saved === null ? null : saved as OmpSkillSettingValue, source: session.settings.getProvenance(definition) };
	});
	return { version: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries };
}

export async function saveSkillSettings(session: AgentSession, version: unknown, patch: unknown, cancelled = () => false): Promise<UiOmpSkillSettings> {
	if (typeof version !== "string" || !isRecord(patch) || !Object.keys(patch).length || JSON.stringify(patch).length > 32768) throw new SkillSettingsError("Invalid skill settings");
	for (const [key, value] of Object.entries(patch)) {
		if (!Object.hasOwn(definitions, key)) throw new SkillSettingsError("Unknown skill setting");
		const definition = definitions[key as OmpSkillSettingKey];
		if (value === null) continue;
		if (definition.type === "boolean" ? typeof value !== "boolean" : !Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== "string" || !item.trim() || item.length > 2048)) throw new SkillSettingsError("Invalid skill setting value");
		definition.assertWritable(value);
	}
	// Separate from OMP's own config-file lock, which flush acquires internally.
	const release = await lockfile.lock(join(session.settings.getAgentDir(), "web-skill-settings"), { realpath: false, stale: 30000, retries: { retries: 40, minTimeout: 20, maxTimeout: 200 } });
	try {
		if (session.isStreaming) throw new SkillSettingsError("Stop the current task before changing skills");
		await session.settings.reloadFromDisk();
		if (cancelled() || session.isStreaming) throw new SkillSettingsError("Skill settings operation cancelled");
		if (skillSettingsView(session).version !== version) throw new SkillSettingsError("Skill settings changed; reload before saving");
		for (const [key, value] of Object.entries(patch)) {
			const definition = definitions[key as OmpSkillSettingKey];
			if (value === null) session.settings.unsetGlobalValue(definition);
			else session.settings.writeValue(definition, value, "global");
		}
		await session.settings.flush();
		await session.settings.reloadFromDisk();
		const result = skillSettingsView(session);
		for (const [key, value] of Object.entries(patch)) if (JSON.stringify(result.entries.find(entry => entry.key === key)?.global) !== JSON.stringify(value)) throw new SkillSettingsError("Skill settings changed during save; reload before continuing");
		// Await native discovery and prompt rebuilding, not just the disk write.
		await session.refreshSkillsAndCommands();
		return result;
	} finally { await release(); }
}
