/** Read only, user-scoped adapters. Never evaluate helpers, shell, plugins or OAuth. */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as toml } from "smol-toml";
import { parse as jsonc, type ParseError } from "jsonc-parser";
import type { ModelSourceId, ModelSourceStatus } from "./protocol.js";

export const capabilityFields = ["reasoning", "input", "contextWindow", "maxTokens"] as const;
export type Capability = typeof capabilityFields[number];
export type Connection = {
	/** Missing declarations, distinct from runtime defaults. Server-only. */
	unknownCapabilities?: Capability[];
	source: ModelSourceId;
	slot: string;
	id: string;
	api: "anthropic-messages" | "openai-responses" | "openai-completions";
	baseUrl: string;
	key: string;
	headers: Record<string, string>;
	authHeader: boolean;
	authentication?: "api-key" | "bearer";
	name?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
};
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : {};
const string = (v: unknown): string => typeof v === "string" ? v : "";
class SourceError extends Error {
	constructor(readonly kind: ModelSourceStatus["status"], readonly missing?: string[]) { super(kind); }
}
export interface DiscoveryOptions { home?: string; env?: NodeJS.ProcessEnv; disabled?: ModelSourceId[] }
export function discoverModels(options: DiscoveryOptions = {}): { connections: Connection[]; statuses: ModelSourceStatus[]; files: string[] } {
	const home = options.home ?? homedir(), env = options.env ?? process.env;
	const files = new Set<string>(), connections: Connection[] = [], statuses: ModelSourceStatus[] = [];
	const path = (v: string) => v.startsWith("~/") ? join(home, v.slice(2)) : resolve(v);
	const read = (file: string, format = "json"): ObjectValue | undefined => {
		files.add(file);
		let raw: string;
		try { raw = readFileSync(file, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new SourceError("unreadable"); }
		try {
			if (format === "toml") return object(toml(raw));
			const errors: ParseError[] = [];
			const parsed = jsonc(raw, errors, { allowTrailingComma: true });
			if (errors.length || !parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
			return parsed;
		} catch { throw new SourceError("invalid"); }
	};
	const required = (value: unknown): string => { const v = string(value); if (!v) throw new SourceError("incomplete"); return v; };
	const environment = (name: string) => {
		const value = env[name];
		if (!value) throw new SourceError("incomplete", /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name) ? [name] : undefined);
		return value;
	};
	const literal = (value: unknown): string => {
		const v = required(value);
		// SDK config strings have command/env semantics. Runtime keys bypass those;
		// headers cannot safely represent these strings with registerProvider.
		if (v.trimStart().startsWith("!") || /[\r\n]/.test(v) || (env[v] !== undefined && env[v] !== v)) throw new SourceError("unsupported");
		return v;
	};
	const add = (source: ModelSourceId, slot: string, id: unknown, api: Connection["api"], url: unknown, key: unknown, headers: ObjectValue = {}, metadata: ObjectValue = {}, authHeader = false) => {
		const model = required(id), baseUrl = required(url), secret = required(key);
		let parsed: URL;
		try { parsed = new URL(baseUrl); } catch { throw new SourceError("incomplete"); }
		if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new SourceError("unsupported");
		const safeHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, literal(v)]));
		if ((metadata.reasoning !== undefined && typeof metadata.reasoning !== "boolean") ||
			(metadata.input !== undefined && (!Array.isArray(metadata.input) || !metadata.input.length || metadata.input.some(v => v !== "text" && v !== "image"))) ||
			["contextWindow", "maxTokens"].some(field => metadata[field] !== undefined && (typeof metadata[field] !== "number" || !Number.isFinite(metadata[field]) || Number(metadata[field]) <= 0))) throw new SourceError("unsupported");
		const positive = (v: unknown, fallback: number) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
		connections.push({ source, slot, id: model, api, baseUrl: parsed.href, key: secret, headers: safeHeaders, authHeader, authentication: api === "anthropic-messages" && safeHeaders.Authorization === `Bearer ${secret}` ? "bearer" : "api-key",
			unknownCapabilities: capabilityFields.filter(field => metadata[field] === undefined),
			name: string(metadata.name) || undefined, reasoning: metadata.reasoning === true,
			input: Array.isArray(metadata.input) && metadata.input.includes("image") ? ["text", "image"] : ["text"],
			contextWindow: positive(metadata.contextWindow, 32768), maxTokens: positive(metadata.maxTokens, 4096) });
	};
	let failures: SourceError[] = [];
	const attempt = (fn: () => void) => {
		const start = connections.length;
		try { fn(); } catch (error) {
			connections.splice(start);
			failures.push(error instanceof SourceError ? error : new SourceError("invalid"));
		}
	};
	const run = (source: ModelSourceId, fn: () => boolean) => {
		if (options.disabled?.includes(source)) { statuses.push({ source, enabled: false, status: "disabled", count: 0, checkedAt: Date.now() }); return; }
		failures = [];
		const start = connections.length;
		let status: ModelSourceStatus["status"] = "ready";
		let missing: string[] | undefined;
		try { if (!fn()) status = "missing"; }
		catch (e) { connections.splice(start); status = e instanceof SourceError ? e.kind : "invalid"; missing = e instanceof SourceError ? e.missing : undefined; }
		if (failures.length && status === "ready") {
			status = connections.length > start ? "partial" : failures[0].kind;
			missing = [...new Set(failures.flatMap(f => f.missing ?? []))];
		}
		statuses.push({ source, enabled: true, status, failures: failures.length || undefined, failureReasons: failures.length ? [...new Set(failures.map(f => f.kind))] : undefined, count: connections.length - start, missing, checkedAt: Date.now() });
	};
	run("claude", () => {
		const config = read(join(path(env.CLAUDE_CONFIG_DIR || join(home, ".claude")), "settings.json"));
		if (!config) return false;
		if (config.modelOverrides) throw new SourceError("unsupported");
		const vars = { ...env, ...object(config.env) };
		if (vars.CLAUDE_CODE_USE_BEDROCK || vars.CLAUDE_CODE_USE_VERTEX || vars.CLAUDE_CODE_USE_FOUNDRY) throw new SourceError("unsupported");
		const headers: ObjectValue = {};
		for (const line of string(vars.ANTHROPIC_CUSTOM_HEADERS).split("\n").filter(Boolean)) {
			const colon = line.indexOf(":"); if (colon < 1) throw new SourceError("invalid");
			headers[line.slice(0, colon)] = line.slice(colon + 1).trim();
		}
		const key = vars.ANTHROPIC_API_KEY || vars.ANTHROPIC_AUTH_TOKEN;
		if (!key && config.apiKeyHelper) throw new SourceError("unsupported");
		if (vars.ANTHROPIC_AUTH_TOKEN && !vars.ANTHROPIC_API_KEY) headers.Authorization = `Bearer ${required(key)}`;
		const selected = vars.ANTHROPIC_MODEL || config.model;
		const aliases: ObjectValue = { opus: vars.ANTHROPIC_DEFAULT_OPUS_MODEL, sonnet: vars.ANTHROPIC_DEFAULT_SONNET_MODEL, haiku: vars.ANTHROPIC_DEFAULT_HAIKU_MODEL };
		const models = [...new Set([aliases[string(selected)] || selected, vars.ANTHROPIC_DEFAULT_OPUS_MODEL, vars.ANTHROPIC_DEFAULT_SONNET_MODEL, vars.ANTHROPIC_DEFAULT_HAIKU_MODEL].filter(Boolean))];
		if (!models.length) throw new SourceError("incomplete");
		for (const id of models) attempt(() => {
			if (/^(default|sonnet|opus|haiku|opusplan)(\[.*\])?$/.test(string(id))) throw new SourceError("unsupported");
			add("claude", string(id), id, "anthropic-messages", vars.ANTHROPIC_BASE_URL || "https://api.anthropic.com", key, headers, {}, false);
		});
		return true;
	});
	run("codex", () => {
		const dir = path(env.CODEX_HOME || join(home, ".codex")), config = read(join(dir, "config.toml"), "toml");
		if (!config) return false;

		const profiles = [["default", config], ...Object.entries(object(config.profiles)).map(([id, value]) => [id, { ...config, ...object(value) }])] as [string, ObjectValue][];
		// Newer Codex versions also store user profiles beside config.toml.
		let profileFiles: string[];
		try { profileFiles = readdirSync(dir).filter(name => name.endsWith(".config.toml")).sort(); }
		catch { throw new SourceError("unreadable"); }
		if (profileFiles.length > 128) throw new SourceError("unsupported");
		for (const name of profileFiles) attempt(() => {
			const profile = read(join(dir, name), "toml");
			if (profile) profiles.push([`file:${name}`, { ...config, ...profile, model_providers: { ...object(config.model_providers), ...object(profile.model_providers) } }]);
		});
		for (const [profile, c] of profiles) attempt(() => {
			if (!c.model) return;
			const providers = { ...object(config.model_providers), ...object(c.model_providers) };
			const pid = string(c.model_provider) || "openai", p = object(providers[pid]);
			if (p.auth || p.gateway_oauth || Object.keys(object(p.query_params)).length || (p.wire_api && p.wire_api !== "responses" && p.wire_api !== "chat")) throw new SourceError("unsupported");
			const key = p.env_key ? environment(required(p.env_key)) : p.experimental_bearer_token || ((pid === "openai" || p.requires_openai_auth === true) ? read(join(dir, "auth.json"))?.OPENAI_API_KEY || env.OPENAI_API_KEY : undefined);
			const headers = { ...object(p.http_headers) };
			for (const [name, ref] of Object.entries(object(p.env_http_headers))) headers[name] = environment(required(ref));
			add("codex", profile, c.model, p.wire_api === "chat" ? "openai-completions" : "openai-responses", p.base_url || (pid === "openai" ? "https://api.openai.com/v1" : undefined), key, headers, { contextWindow: c.model_context_window });
		});
		if (!failures.length && !connections.some(c => c.source === "codex")) throw new SourceError("incomplete");
		return true;
	});
	run("opencode", () => {
		const dir = path(env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode"));
		const candidates = env.OPENCODE_CONFIG ? [path(env.OPENCODE_CONFIG)] : [join(dir, "opencode.json"), join(dir, "opencode.jsonc")];
		let config: ObjectValue | undefined;
		for (const file of candidates) { const next = read(file); if (next) config = { ...config, ...next, provider: { ...object(config?.provider), ...object(next.provider) } }; }
		if (!config) return false;
		const authFile = join(path(env.XDG_DATA_HOME || join(home, ".local", "share")), "opencode", "auth.json");
		const interpolate = (v: unknown): string => required(v).replace(/\{(env|file):([^}]+)\}/g, (_all, kind: string, ref: string) => {
			if (kind === "env") return environment(ref);
			const file = ref.startsWith("~/") ? path(ref) : isAbsolute(ref) ? ref : resolve(dirname(candidates[candidates.length - 1]), ref);
			files.add(file);
			try { return required(readFileSync(file, "utf8").trim()); } catch { throw new SourceError("unreadable"); }
		});
		const providerConfigs = { ...object(config.provider) };
		for (const selected of [config.model, config.small_model]) if (typeof selected === "string") {
			const pid = selected.split("/")[0];
			if (["openai", "anthropic"].includes(pid)) providerConfigs[pid] ??= {};
		}
		for (const [pid, raw] of Object.entries(providerConfigs)) attempt(() => {
			if (Array.isArray(config.disabled_providers) && config.disabled_providers.includes(pid)) return;
			if (Array.isArray(config.enabled_providers) && !config.enabled_providers.includes(pid)) return;
			const p = object(raw), o = object(p.options), credential = o.apiKey ? {} : object(read(authFile)?.[pid]);
			const api = p.npm === "@ai-sdk/anthropic" || (!p.npm && pid === "anthropic") ? "anthropic-messages" : p.npm === "@ai-sdk/openai-compatible" ? "openai-completions" : p.npm === "@ai-sdk/openai" || (!p.npm && pid === "openai") ? "openai-responses" : undefined;
			if (!api) throw new SourceError("unsupported");
			const key = o.apiKey ? interpolate(o.apiKey) : credential.type === "api" ? credential.key : (pid === "anthropic" ? env.ANTHROPIC_API_KEY : pid === "openai" ? env.OPENAI_API_KEY : undefined);
			const headers = Object.fromEntries(Object.entries(object(o.headers)).map(([k, v]) => [k, interpolate(v)]));
			const models = { ...object(p.models) };
			for (const selected of [config.model, config.small_model]) if (typeof selected === "string" && selected.startsWith(pid + "/")) models[selected.slice(pid.length + 1)] ??= {};
			for (const [id, rawModel] of Object.entries(models)) attempt(() => {
				const m = object(rawModel), limit = object(m.limit), modalities = object(m.modalities);
				if (Object.keys(object(m.options)).length || Object.keys(object(m.variants)).length || Object.keys(o).some(k => !["apiKey", "baseURL", "headers"].includes(k))) throw new SourceError("unsupported");
				add("opencode", `${pid}/${id}`, m.id || id, api, o.baseURL ? interpolate(o.baseURL) : pid === "anthropic" ? "https://api.anthropic.com" : pid === "openai" ? "https://api.openai.com/v1" : undefined, key, headers,
					{ name: m.name, reasoning: m.reasoning, input: modalities.input, contextWindow: limit.context, maxTokens: limit.output });
			});
		});
		if (!failures.length && !connections.some(c => c.source === "opencode")) throw new SourceError("incomplete");
		return true;
	});
	return { connections, statuses, files: [...files] };
}
