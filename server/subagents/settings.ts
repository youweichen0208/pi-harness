import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { documentDataDir } from "../document-extension-settings.js";
import { writeFileAtomic } from "../private-file.js";

export function subagentSettings(): { enabled: boolean; version: string } {
	let enabled = true;
	try {
		const value = JSON.parse(readFileSync(join(documentDataDir(), "subagents.json"), "utf8"));
		if (!value || typeof value.enabled !== "boolean") throw Error("Invalid subagents.json");
		enabled = value.enabled;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { enabled, version: createHash("sha256").update(JSON.stringify({ enabled })).digest("hex") };
}

export function toggleSubagents(enabled: boolean, version: string): void {
	if (typeof enabled !== "boolean") throw Error("Invalid subagent setting");
	if (subagentSettings().version !== version) throw Error("Subagent settings changed; refresh and retry");
	writeFileAtomic(join(documentDataDir(), "subagents.json"), JSON.stringify({ enabled }, null, "\t") + "\n");
}
