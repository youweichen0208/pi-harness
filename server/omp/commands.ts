import type { SlashCommandInfo, UiCommandOutput } from "../protocol.js";
import { stripVTControlCharacters } from "node:util";
import { isRecord } from "./framing.js";

/** Preserve native command provenance and aliases without exposing SDK objects. */
export function projectCommands(value: unknown): SlashCommandInfo[] {
	const commands: SlashCommandInfo[] = [{ name: "new", description: "新建原生会话，保留旧历史和当前终端", descriptionEn: "Start a native session, keeping history and current terminals", source: "builtin" }];
	const seen = new Set(["new"]);
	if (!Array.isArray(value)) return commands;
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.name !== "string" || !["builtin", "extension", "skill", "custom", "mcp_prompt", "file"].includes(String(entry.source))) continue;
		const names = [entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
		for (const name of names) {
			if (typeof name !== "string" || !name || seen.has(name)) continue;
			seen.add(name);
			commands.push({ name, source: entry.source as SlashCommandInfo["source"],
				description: typeof entry.description === "string" ? entry.description : undefined,
				argumentHint: isRecord(entry.input) && typeof entry.input.hint === "string" ? entry.input.hint : undefined });
		}
	}
	return commands;
}

/** Keep recent native console output bounded independently from the model transcript. */
export function appendCommandOutput(previous: UiCommandOutput[], output: UiCommandOutput): UiCommandOutput[] {
	const limit = 64 * 1024;
	const plain = stripVTControlCharacters(output.text);
	let text = plain.slice(0, limit);
	if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
	const result = [...previous, { ...output, text, truncated: plain.length > text.length || output.truncated }].slice(-20);
	let length = result.reduce((sum, item) => sum + item.text.length, 0);
	while (length > 256 * 1024 && result.length > 1) length -= result.shift()!.text.length;
	return result;
}
