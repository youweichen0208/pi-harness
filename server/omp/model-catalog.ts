/** Bun-only model discovery. Credentials and native model internals stay here. */
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { discoverModelsByProviderType, DiscoveryHttpError, type DiscoveryProviderConfig } from "@oh-my-pi/pi-coding-agent/config/model-discovery";
import { isDiscoveryBearerApiKey } from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";
import type { UiModelConfigEntry, UiProviderConfig } from "../protocol.js";
import { readModelCompat, isChatModelConfig } from "../model-config-merge.js";
import { isRecord } from "./framing.js";

export class ModelCatalogError extends Error {}
const apis = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
type NativeModel = ReturnType<ModelRegistry["getAll"]>[number];

function endpoint(value: unknown): string {
	if (typeof value !== "string" || value.length > 4096) throw new ModelCatalogError("请填写有效的模型服务地址");
	let url: URL;
	try { url = new URL(value); } catch { throw new ModelCatalogError("模型服务地址无效"); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ModelCatalogError("模型服务地址须为不含凭据或查询参数的 HTTP/HTTPS 地址");
	return url.href.replace(/\/+$/, "");
}

export function modelConfigView(model: NativeModel): UiModelConfigEntry {
	return {
		id: model.id, name: model.name, reasoning: model.reasoning,
		input: model.input.filter(value => value === "text" || value === "image"),
		...(typeof model.contextWindow === "number" && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
		...(typeof model.maxTokens === "number" && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
		compat: readModelCompat(model.compat),
	};
}

/** Translate gateway field aliases into OMP's discovery envelope. Native fields
 * retain priority; defaults, output caps and reasoning policy remain native. */
function normalizeCatalogRow(row: Record<string, unknown>): Record<string, unknown> {
	const metadata = { ...(isRecord(row.metadata) ? row.metadata : {}) };
	if (metadata.display_name === undefined && typeof row.display_name === "string") metadata.display_name = row.display_name;
	if (metadata.context_window === undefined && typeof row.context_window === "number" && Number.isSafeInteger(row.context_window) && row.context_window > 0) metadata.context_window = row.context_window;
	const architecture = isRecord(row.architecture) ? row.architecture : {};
	const nativeInput = [row.input, row.input_modalities, architecture.input_modalities, metadata.input_modalities];
	if (!nativeInput.some(value => Array.isArray(value) && value.some(item => typeof item === "string"))) {
		const modalities = Array.isArray(row.modalities) ? row.modalities.filter(value => value === "text" || value === "image") : [];
		if (modalities.length) metadata.input_modalities = modalities;
		else if (typeof row.supports_vision === "boolean") metadata.input_modalities = row.supports_vision ? ["text", "image"] : ["text"];
	}
	return { ...row, metadata };
}

/** Explicit draft probe: never installs a provider or persists the supplied key. */
export async function probeModelCatalog(input: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<UiModelConfigEntry[]> {
	const baseUrl = endpoint(input.baseUrl);
	const api = input.api ?? "openai-completions";
	if (typeof api !== "string" || !apis.has(api)) throw new ModelCatalogError("此协议不支持模型列表探测");
	if (input.apiKey !== undefined && (typeof input.apiKey !== "string" || input.apiKey.length > 16384)) throw new ModelCatalogError("API 密钥无效");
	const headers = { ...extraHeaders };
	const key = typeof input.apiKey === "string" ? input.apiKey.trim() : undefined;
	if (input.authHeader !== false && isDiscoveryBearerApiKey(key)) {
		if (api === "anthropic-messages") { headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
		else if (api === "google-generative-ai") headers["x-goog-api-key"] = key;
		else headers.Authorization = `Bearer ${key}`;
	}
	const config: DiscoveryProviderConfig = { provider: "harness-draft", api: api as DiscoveryProviderConfig["api"], baseUrl, headers, discovery: { type: "openai-models-list", injectV1: false, timeoutMs: 10000 } };
	const context = {
		getBearerApiKeyResolver: async () => undefined,
		fetch: async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			// A gateway redirect must not forward custom authentication headers.
			const response = await fetch(url, { ...init, redirect: "error" });
			if (!response.ok) { await response.body?.cancel(); return new Response(null, { status: response.status }); }
			const reader = response.body?.getReader();
			if (!reader) throw new ModelCatalogError("模型列表响应为空");
			const chunks: Uint8Array[] = []; let size = 0;
			try {
				for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4 * 1024 * 1024) throw new ModelCatalogError("模型列表响应过大"); chunks.push(part.value); }
			} finally { await reader.cancel(); }
			const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!isRecord(payload)) throw new ModelCatalogError("模型列表格式无效");
			// Normalize Google's public list envelope; OMP still owns capability/default resolution.
			if (api === "google-generative-ai" && Array.isArray(payload.models)) {
				payload.data = payload.models.filter(isRecord).filter(model => !Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes("generateContent"))
					.map(model => ({ id: typeof model.name === "string" ? model.name.replace(/^models\//, "") : undefined, metadata: { display_name: model.displayName }, context_length: model.inputTokenLimit, max_output_tokens: model.outputTokenLimit }));
			}
			if (!Array.isArray(payload.data) || payload.data.length > 10000 || payload.data.some(model => !isRecord(model) || typeof model.id !== "string" || !model.id || model.id.length > 1000)) throw new ModelCatalogError("模型列表格式无效");
			payload.data = payload.data.map(model => normalizeCatalogRow(model as Record<string, unknown>));
			return Response.json(payload);
		},
	};
	try {
		let models: NativeModel[];
		try { models = await discoverModelsByProviderType(config, context); }
		catch (error) {
			if (!(error instanceof DiscoveryHttpError) || error.status !== 404 || /\/v\d+[a-z-]*$/.test(baseUrl)) throw error;
			models = await discoverModelsByProviderType({ ...config, baseUrl: `${baseUrl}/v1` }, context);
		}
		const unique = new Map<string, UiModelConfigEntry>();
		for (const model of models) if ((!model.kind || model.kind === "chat") && !unique.has(model.id)) unique.set(model.id, modelConfigView(model));
		if (!unique.size) throw new ModelCatalogError("服务商未返回可用聊天模型");
		return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
	} catch (error) {
		if (error instanceof ModelCatalogError) throw error;
		if (error instanceof DiscoveryHttpError) throw new ModelCatalogError(`模型列表请求失败（HTTP ${error.status}）`);
		throw new ModelCatalogError("模型列表请求失败，请检查地址、认证及网络");
	}
}

export function cloneModelProvider(registry: ModelRegistry, provider: unknown, saved: Record<string, unknown>): UiProviderConfig {
	if (typeof provider !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(provider)) throw new ModelCatalogError("服务商 ID 无效");
	const catalog = registry.getAll().filter(model => model.provider === provider);
	// The current editor has one transport per provider. Match its existing majority-protocol behavior.
	const groups = new Map<string, NativeModel[]>();
	for (const model of catalog) {
		if (!apis.has(model.api)) continue;
		const transport = JSON.stringify([model.api, model.baseUrl]);
		groups.set(transport, [...(groups.get(transport) ?? []), model]);
	}
	const models = [...groups.values()].sort((a, b) => b.length - a.length)[0];
	if (!models?.length) throw new ModelCatalogError("此服务商没有可复制的 API 密钥型模型，请使用原生登录或手动配置");
	const baseUrl = endpoint(models[0].baseUrl);
	const taken = new Set([...Object.keys(saved), ...registry.getAll().map(model => model.provider)]);
	let providerId = `${provider}-2`;
	for (let n = 3; taken.has(providerId); n++) providerId = `${provider}-${n}`;
	return { providerId, api: models[0].api, baseUrl, models: models.map(modelConfigView) };
}

/** Preserve all existing entries/overrides; discovery adds missing chat IDs only. */
export function mergeDiscoveredModels(saved: Record<string, unknown>, discovered: UiModelConfigEntry[]) {
	const previous = Array.isArray(saved.models) ? saved.models : [];
	const ids = new Set(previous.filter(isRecord).filter(isChatModelConfig).map(model => model.id));
	const added = discovered.filter(model => !ids.has(model.id));
	return { config: { ...saved, models: [...previous, ...added] }, added: added.length, total: ids.size + added.length };
}
