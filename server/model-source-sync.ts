import { outputTokenLimit } from "./model-output-floor.js";
import { mergeModelCompat, readModelCompat } from "./model-config-merge.js";
import { parse as jsonc, type ParseError } from "jsonc-parser";
import { createHash } from "node:crypto";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { registerSourceAliases } from "./model-source-alias.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { discoverModels, capabilityFields, type Connection, type DiscoveryOptions } from "./model-sources.js";
import { writeFileAtomic } from "./private-file.js";
import { isSelectableProvider } from "./provider-catalog.js";
import type { ModelOrigin, ModelSourceId, ModelSourceStatus, UiProviderConfig } from "./protocol.js";

interface SavedState {
	version: 1;
	identities?: Record<string, string>;
	aliases?: Record<string, string[]>;
	localAliases?: Record<string, string>;
	nativeAliases?: { provider: string; id: string; slots: string[] }[];
	disabled: ModelSourceId[];
	suppressed: string[];
	local: Record<string, Connection>;
}
interface Entry { aliases: string[]; provider: string; connection: Connection; slots: string[]; origin: ModelOrigin }
interface Binding { runtime: ModelRuntime; busy: () => boolean; changed: () => void; nativeSeen: Set<string>; nativeAliases: Map<string, Provider | undefined>; fallbackModels: Set<string>; applied: number; leases: number; providers: Set<string>; tail: Promise<void> }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sources: ModelSourceId[] = ["pi", "claude", "codex", "opencode"];
const slot = (c: Connection) => `${c.source}:${c.slot}`;
// Identity contains no credentials (including URL query parameters and headers).
const identity = (c: Connection) => "sync-" + createHash("sha256").update(slot(c)).digest("hex").slice(0, 24);
const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, sorted(value)])) : v;
/** Only compare in memory. Never persist or expose credential-derived fingerprints. */
export function equivalent(a: Connection, b: Connection): boolean {
	const request = ({ source: _source, slot: _slot, name: _name, unknownCapabilities: _unknown, ...c }: Connection) => sorted({ ...c, authentication: c.authentication ?? "api-key", headers: Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k.toLowerCase(), v])) });
	return JSON.stringify(request(a)) === JSON.stringify(request(b));
}

/** Complete only undeclared capabilities, never bridge conflicting declarations. */
export function completeCapabilities(connections: Connection[]): Connection[] {
	const compatible = (a: Connection, b: Connection) => {
		const left = { ...a }, right = { ...b };
		for (const field of capabilityFields) {
			if (a.unknownCapabilities?.includes(field) || b.unknownCapabilities?.includes(field)) {
				Object.assign(left, { [field]: right[field] });
			}
		}
		return equivalent(left, right);
	};
	return connections.map(c => {
		const peers = connections.filter(other => compatible(c, other));
		const result = { ...c, unknownCapabilities: [...(c.unknownCapabilities ?? [])] };
		for (const field of c.unknownCapabilities ?? []) {
			const declared = peers.filter(p => !p.unknownCapabilities?.includes(field));
			const values = new Set(declared.map(p => JSON.stringify(p[field])));
			if (values.size === 1) {
				Object.assign(result, { [field]: declared[0][field] });
				result.unknownCapabilities = result.unknownCapabilities.filter(f => f !== field);
			}
		}
		return result;
	});
}

/** SDK lookups may return fresh objects for an unchanged model. Avoid unnecessary auth preflight. */
export function modelConfigurationChanged(a: NonNullable<ReturnType<ModelRuntime["getModel"]>>, b: NonNullable<ReturnType<ModelRuntime["getModel"]>>) {
	const config = (m: typeof a) => [m.provider, m.id, m.api, m.baseUrl, m.reasoning, m.input, m.contextWindow, m.maxTokens, m.compat];
	return JSON.stringify(config(a)) !== JSON.stringify(config(b));
}

function validState(value: unknown): value is SavedState {
	const state = record(value), local = record(state.local), ids = record(state.identities);
	if (state.version !== 1 || !Array.isArray(state.disabled) || state.disabled.some(id => !sources.includes(id)) || !Array.isArray(state.suppressed) || state.suppressed.some(s => typeof s !== "string") || !state.local || typeof state.local !== "object" || Array.isArray(state.local)) return false;
	if (Object.values(ids).some(id => typeof id !== "string" || !/^sync-[a-f0-9]{24}$/.test(id))) return false;
	if (state.aliases !== undefined && (!state.aliases || typeof state.aliases !== "object" || Array.isArray(state.aliases) || Object.entries(record(state.aliases)).some(([id, slots]) => !/^sync-[a-f0-9]{24}$/.test(id) || !Array.isArray(slots) || slots.some(s => typeof s !== "string")))) return false;
	if (state.localAliases !== undefined && Object.entries(record(state.localAliases)).some(([from, to]) => !/^sync-[a-f0-9]{24}$/.test(from) || typeof to !== "string" || !/^sync-[a-f0-9]{24}$/.test(to))) return false;
	if (state.nativeAliases !== undefined && (!Array.isArray(state.nativeAliases) || state.nativeAliases.some(a => !a || typeof a.provider !== "string" || typeof a.id !== "string" || !Array.isArray(a.slots) || a.slots.some((s: unknown) => typeof s !== "string")))) return false;
	return Object.entries(local).every(([id, value]) => {
		const c = record(value);
		if (!/^sync-[a-f0-9]{24}$/.test(id) || !sources.includes(c.source as ModelSourceId) || typeof c.slot !== "string" || typeof c.id !== "string" || !c.id || typeof c.key !== "string" || !c.key || (c.name !== undefined && typeof c.name !== "string") || !["anthropic-messages", "openai-responses", "openai-completions"].includes(String(c.api))) return false;
		if (c.authentication !== undefined && c.authentication !== "api-key" && c.authentication !== "bearer") return false;
		if (typeof c.baseUrl !== "string" || typeof c.reasoning !== "boolean" || typeof c.authHeader !== "boolean" || !Array.isArray(c.input) || c.input.some(v => v !== "text" && v !== "image")) return false;
		if (![c.contextWindow, c.maxTokens].every(v => typeof v === "number" && Number.isFinite(v) && v > 0)) return false;
		if (!c.headers || typeof c.headers !== "object" || Object.values(c.headers).some(v => typeof v !== "string" || /[\r\n]/.test(v))) return false;
		for (const compat of [c.compat, c.providerCompat]) {
			if (compat !== undefined && JSON.stringify(sorted(compat)) !== JSON.stringify(sorted(readModelCompat(compat)))) return false;
		}
		try { const url = new URL(c.baseUrl); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash; } catch { return false; }
	});
}

/** One process-wide catalog per data directory; each runtime applies while idle. */
export class ModelSourceSync {
	private state: SavedState = { version: 1, disabled: [], suppressed: [], local: {} };
	private storageError = false;
	private entries: Entry[] = [];
	private nativeFallbacks = new Map<string, ModelOrigin>();
	private nativeMatches = new Map<string, string>();
	private statuses: ModelSourceStatus[] = [];
	private bindings = new Set<Binding>();
	private watchers: FSWatcher[] = [];
	private timer?: ReturnType<typeof setInterval>;
	private debounce?: ReturnType<typeof setTimeout>;
	private revision = 0;
	private previous = "";
	private piFiles = "";
	private file: string;
	constructor(readonly dataDir: string, readonly agentDir: string, private readonly options: DiscoveryOptions = {}) {
		this.file = join(dataDir, "model-sources.json");
		try {
			const saved = JSON.parse(readFileSync(this.file, "utf8"));
			if (!validState(saved)) throw new Error();
			this.state = saved;
		} catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.storageError = true; }
		this.scan();
	}
	private persist() {
		if (this.storageError) throw new Error("模型同步存储损坏或不可读，请修复 model-sources.json");
		writeFileAtomic(this.file, JSON.stringify(this.state, null, 2) + "\n");
	}
	private scan() {
		const result = discoverModels({ ...this.options, disabled: this.storageError ? sources : this.state.disabled });
		let piStatus: ModelSourceStatus["status"] = "ready", piFiles = "";
		for (const name of ["models.json", "auth.json"]) {
			const file = join(this.agentDir, name); result.files.push(file);
			try {
				const raw = readFileSync(file, "utf8"); piFiles += raw;
				const errors: ParseError[] = []; const parsed = jsonc(raw, errors, { allowTrailingComma: true });
				if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) piStatus = "invalid";
			}
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") piStatus = "unreadable"; }
		}
		this.statuses = [{ source: "pi" as const, enabled: true, status: piStatus, count: 0, checkedAt: Date.now() }, ...result.statuses].map(s => ({ ...s, enabled: !this.state.disabled.includes(s.source), status: this.storageError ? "invalid" : this.state.disabled.includes(s.source) ? "disabled" : s.status }));
		const entries: Entry[] = [];
		const identities = { ...this.state.identities };
		const aliases = structuredClone(this.state.aliases ?? {});
		if (!this.storageError) for (const c of completeCapabilities(result.connections.filter(c => !this.state.suppressed.includes(slot(c))))) {
			if (this.state.disabled.includes(c.source) || this.state.suppressed.includes(slot(c))) continue;
			const duplicate = entries.find(e => equivalent(e.connection, c));
			const provider = identities[slot(c)] || duplicate?.provider || identity(c);
			identities[slot(c)] = provider;
			if (duplicate) { duplicate.slots.push(slot(c)); if (!duplicate.origin.sources.includes(c.source)) duplicate.origin.sources.push(c.source); }
			else entries.push({ aliases: [], provider, connection: c, slots: [slot(c)], origin: { sources: [c.source], mode: "synced" } });
		}
		// A formerly merged identity belongs to the first surviving slot after a
		// split. Previously distinct identities are never overwritten by a merge.
		const owners = new Map<string, Entry>();
		for (const entry of entries) {
			for (const key of entry.slots) {
				let provider = identities[key];
				if (owners.has(provider) && owners.get(provider) !== entry) {
					provider = "sync-" + createHash("sha256").update(key).digest("hex").slice(0, 24);
					identities[key] = provider;
				}
				owners.set(provider, entry);
				aliases[provider] = entry.slots;
			}
			entry.provider = identities[entry.slots[0]];
		}
		// An identity whose own source disappeared can use a surviving member
		// of its last equivalent group. Only source slots, never secrets, persist.
		for (const [provider, keys] of Object.entries(aliases)) {
			if (this.state.local[provider] || this.state.localAliases?.[provider]) continue;
			const entry = owners.get(provider) ?? entries.find(e => e.slots.some(key => keys.includes(key)));
			if (entry) entry.aliases.push(provider);
		}
		if (!this.storageError && (JSON.stringify(identities) !== JSON.stringify(this.state.identities ?? {}) || JSON.stringify(aliases) !== JSON.stringify(this.state.aliases ?? {}))) {
			const previous = this.state; this.state = { ...previous, identities, aliases };
			try { this.persist(); } catch { this.state = previous; this.storageError = true; entries.length = 0; }
		}
		if (!this.storageError) for (const [provider, c] of Object.entries(this.state.local)) entries.push({ aliases: [...new Set([provider, ...Object.entries(this.state.localAliases ?? {}).filter(([, target]) => target === provider).map(([alias]) => alias)])], provider, connection: c, slots: [], origin: { sources: [c.source], mode: "local" } });
		// Apply after identity/deduplication: a deployment override must not merge
		// conflicting source declarations. Independent models use the same floor.
		for (const entry of entries) {
			const c = entry.connection;
			const maxTokens = outputTokenLimit(c.maxTokens, c.contextWindow, this.options.env ?? process.env);
			if (maxTokens > c.maxTokens) entry.connection = { ...c, maxTokens, unknownCapabilities: c.unknownCapabilities?.filter(field => field !== "maxTokens") };
		}
		const next = JSON.stringify([entries, this.statuses.map(s => s.status)]);
		if (next !== this.previous || piFiles !== this.piFiles) { this.revision++; this.previous = next; this.piFiles = piFiles; this.entries = entries; }
		this.watchFiles([...result.files, this.file]);
	}
	private watchFiles(files: string[]) {
		for (const watcher of this.watchers) watcher.close();
		this.watchers = [];
		if (!this.bindings.size) return;
		for (const dir of new Set(files.map(dirname))) {
			try {
				const names = new Set(files.filter(file => dirname(file) === dir).map(file => basename(file)));
				const watcher = watch(dir, { persistent: false }, (_event, filename) => {
					if (filename && !names.has(String(filename))) return;
					clearTimeout(this.debounce);
					this.debounce = setTimeout(() => { void this.sync(); }, 150);
				});
				watcher.on("error", () => {}); this.watchers.push(watcher);
			} catch { /* Missing directories are retried by the 30s poll. */ }
		}
	}
	async bind(runtime: ModelRuntime, busy: () => boolean, changed: () => void): Promise<() => void> {
		const binding: Binding = { runtime, busy, changed, nativeSeen: new Set(), nativeAliases: new Map(), fallbackModels: new Set(), applied: -1, leases: 0, providers: new Set(), tail: Promise.resolve() };
		this.bindings.add(binding);
		if (!this.timer) { this.timer = setInterval(() => { void this.sync(); }, 30_000); this.timer.unref(); }
		this.scan(); await this.apply(binding);
		return () => { this.bindings.delete(binding); if (!this.bindings.size) { clearInterval(this.timer); this.timer = undefined; clearTimeout(this.debounce); for (const w of this.watchers) w.close(); this.watchers = []; } };
	}
	private apply(b: Binding): Promise<void> {
		b.tail = b.tail.catch(() => {}).then(async () => {
			if (b.leases || b.busy() || b.applied === this.revision) return;
			const revision = this.revision, entries = [...this.entries];
			// Callers await this queue before admitting a new turn. No network catalog refresh.
			for (const model of b.runtime.getAvailableSnapshot()) if (!this.owns(model.provider)) b.nativeSeen.add(`${model.provider}/${model.id}`);
			for (const [provider, original] of b.nativeAliases) {
				b.runtime.unregisterProvider(provider);
				if (original) b.runtime.registerNativeProvider(original);
			}
			b.nativeAliases.clear(); b.fallbackModels.clear();
			await b.runtime.refresh({ allowNetwork: false });
			for (const provider of b.providers) { b.runtime.unregisterProvider(provider); await b.runtime.removeRuntimeApiKey(provider); }
			b.providers.clear();
			await b.runtime.refresh({ allowNetwork: false });
			this.matchNative(b.runtime);
			for (const entry of entries) for (const provider of entry.aliases) {
				const e = { ...entry, provider };
				const c = e.connection;
				b.runtime.registerProvider(e.provider, { name: `${c.name || c.id} · ${e.origin.sources.join(" / ")}`, baseUrl: c.baseUrl, api: c.api, headers: Object.fromEntries(Object.entries(c.headers).map(([key, value]) => [key, (value.startsWith("!") ? "$" : "") + value.split("$").join("$$")])), authHeader: c.authHeader,
					models: [{ id: c.id, name: c.name || c.id, reasoning: c.reasoning, input: c.input, contextWindow: c.contextWindow, maxTokens: c.maxTokens, compat: { ...readModelCompat(c.providerCompat), ...readModelCompat(c.compat) }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
				if (c.authentication === "bearer") {
					// Header-owned Anthropic auth must not also send x-api-key. This native
					// provider uses the public credential resolver and bypasses config strings.
					const provider = b.runtime.getProvider(e.provider)!;
					b.runtime.unregisterProvider(e.provider);
					b.runtime.registerNativeProvider({ ...provider, headers: undefined, auth: { apiKey: {
						name: "API bearer key",
						resolve: async ({ credential }) => credential?.key ? { auth: { headers: { ...c.headers, Authorization: `Bearer ${credential.key}` } }, source: "runtime" } : undefined,
					} } });
				}
				await b.runtime.setRuntimeApiKey(e.provider, c.key);
				b.providers.add(e.provider);
			}
			this.nativeFallbacks.clear();
			const available = b.runtime.getAvailableSnapshot();
			const fallback = (this.state.nativeAliases ?? []).flatMap(alias => {
				if (available.some(m => m.provider === alias.provider && m.id === alias.id) || b.runtime.getRegisteredNativeProvider(alias.provider) || b.runtime.getRegisteredProviderConfig(alias.provider)) return [];
				const entry = entries.find(e => e.origin.mode === "synced" && e.connection.id === alias.id && e.slots.some(s => alias.slots.includes(s)));
				if (!entry) return [];
				const target = b.runtime.getModel(entry.provider, alias.id);
				if (!target) return [];
				this.nativeFallbacks.set(alias.provider, entry.origin);
				this.nativeMatches.set(entry.provider, alias.provider);
				b.fallbackModels.add(`${alias.provider}/${alias.id}`);
				b.nativeSeen.add(`${alias.provider}/${alias.id}`);
				return [{ provider: alias.provider, target }];
			});
			b.nativeAliases = registerSourceAliases(b.runtime, fallback);
			if (fallback.length) await b.runtime.refresh({ allowNetwork: false });
			b.applied = revision;
		});
		return b.tail;
	}
	/** Compare only literal native API configuration; never invoke a credential helper for deduplication. */
	private matchNative(runtime: ModelRuntime) {
		this.nativeMatches.clear();
		if (this.state.disabled.includes("pi") || this.statuses[0]?.status !== "ready") return;
		const env = this.options.env ?? process.env;
		let nativeAliases = [...(this.state.nativeAliases ?? [])];
		let providers: Record<string, unknown> = {}, auth: Record<string, unknown> = {};
		try { providers = jsonc(readFileSync(join(this.agentDir, "models.json"), "utf8"))?.providers ?? {}; } catch { /* optional */ }
		try { auth = JSON.parse(readFileSync(join(this.agentDir, "auth.json"), "utf8")); } catch { /* optional */ }
		const literal = (value: unknown): string | undefined => typeof value === "string" && !value.trimStart().startsWith("!") && !value.includes("$") ? value : undefined;
		for (const m of runtime.getAvailableSnapshot()) {
			if (this.owns(m.provider) || !isSelectableProvider(m.provider)) continue;
			// A live native configuration is authoritative. Revoke old links when
			// accounts/endpoints/capabilities diverge, before a later deletion.
			if (runtime.isUsingOAuth(m.provider) || runtime.getRegisteredNativeProvider(m.provider) || runtime.getRegisteredProviderConfig(m.provider)) continue;
			const p = record(providers[m.provider]), credential = record(auth[m.provider]);
			const definition = (Array.isArray(p.models) ? p.models.map(record) : []).find(d => d.id === m.id && (!d.type || d.type === "chat"));
			if (p.compat || definition?.compat || m.compat || m.samplingParams || m.samplingParamsByThinkingLevel || record(p.modelOverrides)[m.id]) continue;
			const key = literal(p.apiKey) || (credential.type === "api_key" ? literal(credential.key) : undefined) || env[{ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" }[m.provider] ?? ""];
			if (!key || !["anthropic-messages", "openai-completions", "openai-responses"].includes(m.api)) continue;
			nativeAliases = nativeAliases.filter(a => a.provider !== m.provider || a.id !== m.id);
			const headers: Record<string, string> = {}; let safe = true;
			for (const [k, v] of Object.entries({ ...record(p.headers), ...record(definition?.headers) })) { const resolved = literal(v); if (resolved === undefined) safe = false; else headers[k] = resolved; }
			if (!safe) continue;
			let baseUrl: string; try { baseUrl = new URL(m.baseUrl).href; } catch { continue; }
			const native: Connection = { source: "pi", slot: `${m.provider}/${m.id}`, id: m.id, api: m.api as Connection["api"], baseUrl, key, headers,
				authHeader: p.authHeader === true, reasoning: m.reasoning, input: m.input, contextWindow: m.contextWindow, maxTokens: m.maxTokens };
			for (const entry of this.entries) {
				if (entry.origin.mode !== "synced") continue;
				// Compare effective limits with the candidate native context before
				// completing capabilities; otherwise the conservative context cap
				// itself prevents an otherwise equivalent native match.
				const c = entry.connection;
				const candidate = c.unknownCapabilities?.includes("contextWindow")
					? { ...c, maxTokens: outputTokenLimit(c.maxTokens, native.contextWindow, env) }
					: c;
				const completed = completeCapabilities([candidate, native])[0];
				if (!equivalent(native, completed)) continue;
				entry.connection = completed;
				this.nativeMatches.set(entry.provider, m.provider);
				nativeAliases.push({ provider: m.provider, id: m.id, slots: [...entry.slots] });
			}
		}
		if (JSON.stringify(nativeAliases) !== JSON.stringify(this.state.nativeAliases ?? [])) {
			const previous = this.state.nativeAliases; this.state.nativeAliases = nativeAliases;
			try { this.persist(); } catch (error) { this.state.nativeAliases = previous; throw error; }
		}
	}
	visible(provider: string) { if (this.entries.some(e => e.provider !== provider && e.aliases.includes(provider))) return false; const native = this.nativeMatches.get(provider); return this.selectable(provider) && (!native || !this.selectable(native)); }

	async sync(source?: ModelSourceId, enabled?: boolean, restore = false): Promise<void> {
		if (source !== undefined && !sources.includes(source)) throw new Error("未知模型来源");
		if (source && (enabled !== undefined || restore)) {
			const previous = structuredClone(this.state);
			if (enabled !== undefined) this.state.disabled = enabled ? this.state.disabled.filter(s => s !== source) : [...new Set([...this.state.disabled, source])];
			if (restore) { for (const [alias, target] of Object.entries(this.state.localAliases ?? {})) if (!this.state.local[target]) delete this.state.localAliases![alias]; }
			if (restore) this.state.suppressed = this.state.suppressed.filter(s => !s.startsWith(source + ":") || !!this.state.local[this.state.identities?.[s] ?? ""]);
			try { this.persist(); } catch (error) { this.state = previous; throw error; }
			this.revision++;
		}
		this.scan();
		await Promise.all([...this.bindings].map(async b => { try { await this.apply(b); } catch { /* Retried at next admission; do not leak SDK errors with credentials. */ } b.changed(); }));
	}
	async ready(runtime: ModelRuntime) {
		const b = [...this.bindings].find(b => b.runtime === runtime);
		if (b) { try { await this.apply(b); } catch { throw new Error("模型同步失败，请检查配置后重试"); } }
	}
	async acquire(runtime: ModelRuntime): Promise<() => void> {
		const b = [...this.bindings].find(b => b.runtime === runtime);
		if (!b) return () => {};
		const acquiring = this.apply(b).then(() => { b.leases++; });
		b.tail = acquiring;
		try { await acquiring; } catch { throw new Error("模型同步失败，请检查配置后重试"); }
		let released = false;
		return () => { if (!released) { released = true; b.leases--; } };
	}
	accepts(runtime: ModelRuntime, provider: string, id: string) {
		const binding = [...this.bindings].find(b => b.runtime === runtime);
		if (binding?.fallbackModels.has(`${provider}/${id}`)) return (this.state.nativeAliases ?? []).some(a => a.provider === provider && a.id === id && this.entries.some(e => e.connection.id === id && e.slots.some(s => a.slots.includes(s))));
		if (!this.selectable(provider)) return false;
		if (binding?.nativeAliases.has(provider) || binding?.nativeSeen.has(`${provider}/${id}`) || this.state.nativeAliases?.some(a => a.provider === provider && a.id === id)) return runtime.getAvailableSnapshot().some(m => m.provider === provider && m.id === id);
		return !this.owns(provider) || this.entries.some(e => e.aliases.includes(provider) && e.connection.id === id);
	}

	selectable(provider: string): boolean {
		if (!isSelectableProvider(provider)) return false;
		if (this.owns(provider)) return this.entries.some(e => e.aliases.includes(provider));
		if (this.nativeFallbacks.has(provider)) return true;
		return !this.state.disabled.includes("pi") && this.statuses[0]?.status === "ready";
	}
	origin(provider: string): ModelOrigin {
		const imported = this.entries.find(e => e.aliases.includes(provider))?.origin ?? this.nativeFallbacks.get(provider);
		if (imported) return imported;
		const merged = this.entries.filter(e => this.nativeMatches.get(e.provider) === provider).flatMap(e => e.origin.sources);
		return { sources: [...new Set<ModelSourceId>(["pi", ...merged])], mode: "synced" };
	}
	status(runtime: ModelRuntime): ModelSourceStatus[] {
		const binding = [...this.bindings].find(b => b.runtime === runtime);
		return this.statuses.map(status => ({ ...status, pending: !!binding && binding.applied !== this.revision })).map(s => s.source === "pi" ? { ...s, count: runtime.getAvailableSnapshot().filter(m => !this.owns(m.provider) && isSelectableProvider(m.provider) && !binding?.fallbackModels.has(`${m.provider}/${m.id}`)).length, status: runtime.getError() ? "invalid" : s.status === "ready" && !this.piFiles && !runtime.getAvailableSnapshot().some(m => !this.owns(m.provider)) ? "missing" : s.status } : s);
	}
	configs(): UiProviderConfig[] {
		return this.entries.map(({ provider, connection: c, origin }) => ({ providerId: provider, name: c.name || c.id, api: c.api,
			// Query parameters may hold credentials. Editing an unchanged redacted URL preserves it.
			baseUrl: c.baseUrl.split("?")[0], authHeader: c.authHeader, origin, compat: readModelCompat(c.providerCompat),
			models: [{ id: c.id, name: c.name, reasoning: c.reasoning, input: c.input, contextWindow: c.contextWindow, maxTokens: c.maxTokens, compat: readModelCompat(c.compat) }] }));
	}
	owns(provider: string) { return /^sync-[a-f0-9]{24}$/.test(provider); }
	async edit(provider: string, config?: UiProviderConfig) {
		const entry = this.entries.find(e => e.provider === provider);
		if (!entry) throw new Error("同步入口已失效，请先恢复来源");
		const previous = structuredClone(this.state);
		this.state.suppressed = [...new Set([...this.state.suppressed, ...entry.slots])];
		if (!config) delete this.state.local[provider];
		else {
			if (config.models.length !== 1 || !["anthropic-messages", "openai-responses", "openai-completions"].includes(config.api || "")) { this.state = previous; throw new Error("独立配置需要一个受支持的模型"); }
			const c = entry.connection, m = config.models[0];
			let compat, providerCompat;
			try { compat = readModelCompat(mergeModelCompat(c.compat, m.compat)); providerCompat = readModelCompat(mergeModelCompat(c.providerCompat, config.compat)); }
			catch (error) { this.state = previous; throw error; }
			const baseUrl = config.baseUrl === c.baseUrl.split("?")[0] ? c.baseUrl : config.baseUrl || c.baseUrl;
			try { const u = new URL(baseUrl); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error(); }
			catch { this.state = previous; throw new Error("接口地址无效"); }
			const key = config.apiKey?.trim() || c.key;
			const headers = { ...c.headers };
			if (!c.authHeader && headers.Authorization === `Bearer ${c.key}`) headers.Authorization = `Bearer ${key}`;
			this.state.local[provider] = { ...c, compat, providerCompat, unknownCapabilities: [], headers, authHeader: config.authHeader ?? c.authHeader, id: m.id, name: config.name || m.name, api: config.api as Connection["api"], baseUrl, key,
				reasoning: m.reasoning ?? false, input: m.input?.includes("image") ? ["text", "image"] : ["text"], contextWindow: m.contextWindow || c.contextWindow, maxTokens: m.maxTokens || c.maxTokens };
		}
		if (config) this.state.localAliases = { ...this.state.localAliases, ...Object.fromEntries(entry.aliases.filter(id => id !== provider).map(id => [id, provider])) };
		if (!validState(this.state)) { this.state = previous; throw new Error("独立模型配置无效"); }
		try { this.persist(); } catch (error) { this.state = previous; throw error; }
		await this.sync();
	}
}
const catalogs = new Map<string, ModelSourceSync>();
export function modelSourcesFor(dataDir: string, agentDir: string) {
	const key = `${dataDir}\0${agentDir}`;
	let catalog = catalogs.get(key);
	if (!catalog) { catalog = new ModelSourceSync(dataDir, agentDir); catalogs.set(key, catalog); }
	return catalog;
}
