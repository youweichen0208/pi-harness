/** Read-only adapters for OMP's serialized messages; never change the native transcript. */
import { isRecord } from "./framing.js";

/** A user skill stores its original invocation separately from its expanded model content.
 * Keep this wire projection aligned with OMP's public titleTextFromSkillPrompt helper.
 * SDK modules run in Bun; this adapter is also consumed by the Node host. */
export function skillUserDraft(value: unknown): string | undefined {
	if (!isRecord(value) || value.role !== "custom" || value.customType !== "skill-prompt" || value.attribution !== "user" || !isRecord(value.details)) return;
	const details = value.details;
	for (const key of ["__queueChipText", "prompt"]) if (typeof details[key] === "string" && details[key].trim()) return details[key].trim();
	const name = typeof details.name === "string" ? details.name.trim() : "";
	const args = typeof details.args === "string" ? details.args.trim() : "";
	return (name ? `/skill:${name}${args ? ` ${args}` : ""}` : args) || undefined;
}

/** RPC get_entries carries custom-message payloads on the entry, not entry.message. */
export function nativeEntryMessage(entry: unknown): unknown {
	if (!isRecord(entry)) return;
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") return { role: "custom", customType: entry.customType, content: entry.content,
		details: entry.details, display: entry.display, attribution: entry.attribution,
		timestamp: typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : entry.timestamp };
}
