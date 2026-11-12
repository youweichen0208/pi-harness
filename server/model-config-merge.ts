import type { UiModelCompat, UiProviderConfig } from "./protocol.js";

const booleanCompatKeys = ["supportsMessageThreads", "requiresNonNullAssistantContent", "requiresToolsWithToolHistory"] as const;
const compatKeys = [...booleanCompatKeys, "promptCacheKeyMode"] as const;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validCompatValue = (key: typeof compatKeys[number], value: unknown) => key === "promptCacheKeyMode"
	? value === "auto" || value === "enabled" || value === "disabled" : typeof value === "boolean";

/** Only documented non-secret fields cross the wire, including explicit false. */
export function readModelCompat(value: unknown): { [K in keyof UiModelCompat]?: NonNullable<UiModelCompat[K]> } | undefined {
	const raw = object(value);
	const entries = compatKeys.filter(key => validCompatValue(key, raw[key])).map(key => [key, raw[key]]);
	return entries.length ? Object.fromEntries(entries) : undefined;
}

/** A patch owns only the whitelist. Unknown native fields remain server-side. */
export function mergeModelCompat(previous: unknown, patch: UiModelCompat | undefined): Record<string, unknown> | undefined {
	if (patch === undefined) return previous as Record<string, unknown> | undefined;
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid model compatibility settings");
	const result = { ...object(previous) };
	for (const key of compatKeys) {
		if (!Object.hasOwn(patch, key) || patch[key] === undefined) continue;
		const value = patch[key];
		if (value === null) delete result[key];
		else if (validCompatValue(key, value)) result[key] = value;
		else throw new Error(`Invalid compatibility setting: ${key}`);
	}
	return Object.keys(result).length ? result : undefined;
}

function applyCompat(result: Record<string, unknown>, patch: UiModelCompat | undefined) {
	const compat = mergeModelCompat(result.compat, patch);
	if (compat === undefined) delete result.compat;
	else result.compat = compat;
}

export const isChatModelConfig = (model: Record<string, unknown>): boolean => model.type === undefined || model.type === "chat";

/** A chat editor owns chat fields only; keep provider operations and typed models intact. */
export function mergeChatProvider(previous: Record<string, unknown>, config: UiProviderConfig): Record<string, unknown> {
	const existing = Array.isArray(previous.models) ? previous.models as Record<string, unknown>[] : [];
	const typed = existing.filter(model => !isChatModelConfig(model));
	const ids = new Set<string>();
	const models = config.models.filter(model => model.id.trim()).map(model => {
		const id = model.id.trim();
		if (ids.has(id)) throw new Error(`Duplicate chat model ID: ${id}`);
		ids.add(id);
		const result: Record<string, unknown> = { ...existing.find(entry => entry.id === id && isChatModelConfig(entry)), id };
		applyCompat(result, model.compat);
		for (const key of ["name", "reasoning", "input", "contextWindow", "maxTokens"] as const) {
			delete result[key];
			const value = model[key];
			if (value !== undefined && value !== "") result[key] = value;
		}
		return result;
	});
	const result: Record<string, unknown> = { ...previous, models: [...models, ...typed] };
	applyCompat(result, config.compat);
	for (const key of ["name", "api", "baseUrl", "authHeader"] as const) {
		delete result[key];
		const value = config[key];
		if (value !== undefined && value !== "") result[key] = value;
	}
	// An empty key in an existing editor means retain the server-owned credential.
	if (config.apiKey?.trim()) result.apiKey = config.apiKey.trim();
	return result;
}
