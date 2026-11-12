import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { normalizeContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { discoverModels } from "../../server/model-sources.js";
import { ModelSourceSync, equivalent, completeCapabilities } from "../../server/model-source-sync.js";
const dirs: string[] = [];
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "model-sources-")); dirs.push(home);
	const put = (file: string, value: unknown) => { const path = join(home, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
	const claude = (key = "secret-one") => put(".claude/settings.json", { model: "claude-example-1", env: { ANTHROPIC_API_KEY: key } });
	return { home, put, claude, options: { home, env: {} } };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("read-only API discovery", () => {
	it.each(["claude-sonnet-4-5", "codeagent/maas-glm-5.3-volcengine-codeagent[1m]"])("allows image input for Claude Code model %s (#165)", model => {
		const f = fixture();
		f.put(".claude/settings.json", { model, env: { ANTHROPIC_BASE_URL: "https://gateway.example/", ANTHROPIC_AUTH_TOKEN: "fixture-key" } });
		const connection = discoverModels(f.options).connections[0];
		expect(connection.input).toEqual(["text", "image"]);
		expect(connection.unknownCapabilities).not.toContain("input");
	});
	it("requires no Pi or CLI and does not invent models for absent sources", () => {
		const f = fixture(); expect(discoverModels(f.options).statuses.every(s => s.status === "missing")).toBe(true);
		f.claude(); const r = discoverModels(f.options); expect(r.connections).toHaveLength(1); expect(r.connections[0].api).toBe("anthropic-messages");
	});
	it.each([
		{ model: "claude-example[1m]", env: {} },
		{ model: "claude-example[1M]", env: {} },
		{ model: "opus[1m]", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-example[1m]" } },
		{ model: "sonnet[1m]", env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-example" } },
		{ model: "sonnet", env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-example[1m]" } },
		{ model: "ignored", env: { ANTHROPIC_MODEL: "claude-example[1m]" } },
	])("imports Claude long-context syntax as capability metadata: %j", config => {
		const f = fixture();
		f.put(".claude/settings.json", { ...config, env: { ANTHROPIC_API_KEY: "fixture-key", ...config.env } });
		const result = discoverModels(f.options);
		expect(result.statuses.find(s => s.source === "claude")?.status).toBe("ready");
		expect(result.connections.some(c => c.id === "claude-example" && c.contextWindow === 1_000_000 && !c.unknownCapabilities?.includes("contextWindow"))).toBe(true);
		expect(result.connections.every(c => !c.id.includes("[1m]"))).toBe(true);
	});

	it("does not invent a concrete model for an unresolved long-context alias", () => {
		const f = fixture();
		f.put(".claude/settings.json", { model: "sonnet[1m]", env: { ANTHROPIC_API_KEY: "fixture-key" } });
		const result = discoverModels(f.options);
		expect(result.connections).toEqual([]);
		expect(result.statuses.find(s => s.source === "claude")?.status).toBe("unsupported");
	});

	it("does not read disabled sources and reports missing environment references", () => {
		const f = fixture(); f.claude();
		expect(discoverModels({ ...f.options, disabled: ["claude", "codex", "opencode"] }).files).toEqual([]);
		f.put(".codex/config.toml", 'model="m"\nmodel_provider="custom"\n[model_providers.custom]\nbase_url="http://localhost:9999/v1"\nenv_key="MISSING_FIXTURE_KEY"');
		expect(discoverModels(f.options).statuses.find(s => s.source === "codex")?.missing).toEqual(["MISSING_FIXTURE_KEY"]);
	});

	it("reads Codex profiles, environment references and explicit API keys, excludes subscription tokens", () => {
		const f = fixture(); f.put(".codex/config.toml", 'model = "gpt-example"\n[profiles.other]\nmodel = "gpt-other"\n');
		f.put(".codex/auth.json", { tokens: { access_token: "subscription-secret" } });
		expect(discoverModels(f.options).connections).toHaveLength(0);
		f.put(".codex/auth.json", { OPENAI_API_KEY: "api-secret" });
		expect(discoverModels(f.options).connections.map(c => c.id)).toEqual(["gpt-example", "gpt-other"]);
		f.put(".codex/team.config.toml", 'model="gpt-team"');
		expect(discoverModels(f.options).connections.map(c => c.id)).toContain("gpt-team");
	});
	it("OpenCode JSONC resolves only explicit env/file references", () => {
		const f = fixture(); f.put("key.txt", "file-secret\n");
		f.put(".config/opencode/opencode.jsonc", `{// comment\n"provider":{"gateway":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://localhost:9999/v1?route=A","apiKey":"{file:${join(f.home, "key.txt").replaceAll('\\', '\\\\')}}"},"models":{"A":{"limit":{"context":8192,"output":2048}}}}},}`);
		const r = discoverModels(f.options); expect(r.connections[0]).toMatchObject({ id: "A", key: "file-secret", contextWindow: 8192 });
		expect(r.files).toContain(join(f.home, "key.txt"));
	});
	it("rejects executable header semantics without running helpers, and isolates malformed sources", () => {
		const f = fixture(); f.claude(); f.put(".codex/config.toml", 'model = [ invalid');
		expect(discoverModels(f.options).connections).toHaveLength(1);
		f.put(".claude/settings.json", { model: "claude-test", apiKeyHelper: "touch should-not-exist" });
		expect(discoverModels(f.options).statuses.find(s => s.source === "claude")?.status).toBe("unsupported");
		f.put(".claude/settings.json", { model: "claude-test", env: { ANTHROPIC_API_KEY: "safe", ANTHROPIC_CUSTOM_HEADERS: "x-key: !touch should-not-exist" } });
		expect(discoverModels(f.options).statuses.find(s => s.source === "claude")?.status).toBe("unsupported");
	});
	it("isolates invalid models, providers, aliases and profile files within a source", () => {
		const f = fixture();
		f.put(".claude/settings.json", { model: "sonnet", env: { ANTHROPIC_API_KEY: "key", ANTHROPIC_DEFAULT_HAIKU_MODEL: "valid-claude" } });
		f.put(".codex/config.toml", 'model="valid-codex"\n[profiles.bad]\nmodel="bad"\nmodel_provider="custom"\n[model_providers.custom]\nenv_key="MISSING_KEY"');
		f.put(".codex/auth.json", { OPENAI_API_KEY: "key" });
		f.put(".codex/broken.config.toml", "model=[ broken");
		f.put(".config/opencode/opencode.json", { provider: {
			good: { npm: "@ai-sdk/openai", options: { baseURL: "https://example.com/v1", apiKey: "key" }, models: { valid: {}, bad: { options: { unsupported: true } } } },
			bad: { npm: "unsupported" },
		} });
		const result = discoverModels(f.options);
		expect(result.connections.map(c => c.id)).toEqual(["valid-claude", "valid-codex", "valid"]);
		expect(result.statuses.map(s => s.status)).toEqual(["partial", "partial", "partial"]);
		expect(result.statuses.find(s => s.source === "codex")).toMatchObject({ count: 1, failures: 2, missing: ["MISSING_KEY"] });
	});

	it("uses declared capabilities only for matching connections without bridging conflicts", () => {
		const f = fixture(); f.claude();
		const unknown = discoverModels(f.options).connections[0];
		const declared = { ...unknown, source: "opencode" as const, slot: "explicit", unknownCapabilities: [], contextWindow: 200000, maxTokens: 8192, reasoning: true, input: ["text", "image"] as ("text" | "image")[] };
		const completed = completeCapabilities([unknown, declared]);
		expect(equivalent(completed[0], declared)).toBe(true);
		expect(completed[0].unknownCapabilities).toEqual([]);
		expect(completeCapabilities([unknown, { ...declared, key: "other-account" }])[0]).toEqual(unknown);
		const conflict = { ...declared, contextWindow: 100000 };
		expect(completeCapabilities([unknown, declared, conflict])[0].contextWindow).toBe(32768);
		expect(equivalent(declared, conflict)).toBe(false);
		expect(completeCapabilities([declared, unknown])[1]).toEqual(completed[0]);
	});

	it("preserves case, paths, query and different credentials/capabilities when deduplicating", () => {
		const f = fixture(); f.claude(); const a = discoverModels(f.options).connections[0];
		expect(equivalent(a, { ...a, source: "codex", slot: "other" })).toBe(true);
		for (const delta of [{ key: "other" }, { id: "CLAUDE-example-1" }, { baseUrl: a.baseUrl + "?a=b" }, { contextWindow: 1 }, { headers: { "x-test": "value" } }]) expect(equivalent(a, { ...a, ...delta })).toBe(false);
	});
});
describe("runtime synchronization", () => {
	it("registers a clean API model ID with 1M context and merges a matching declaration", async () => {
		const f = fixture();
		f.put(".claude/settings.json", { model: "sonnet[1m]", env: { ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-example" } });
		f.put(".config/opencode/opencode.json", { provider: { anthropic: { options: { apiKey: "fixture-key" }, models: { "claude-example": { limit: { context: 1_000_000 } } } } } });
		const agentDir = join(f.home, "pi");
		const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), authPath: join(agentDir, "auth.json"), allowModelNetwork: false });
		const sync = new ModelSourceSync(join(f.home, "data"), agentDir, f.options);
		const unbind = await sync.bind(runtime, () => false, () => {});
		try {
			expect(sync.configs()).toHaveLength(1);
			const config = sync.configs()[0];
			expect(config.origin?.sources).toEqual(["claude", "opencode"]);
			expect(runtime.getModel(config.providerId, "claude-example")).toMatchObject({ id: "claude-example", contextWindow: 1_000_000 });
			expect(runtime.getModel(config.providerId, "claude-example[1m]")).toBeUndefined();
		} finally { unbind(); }
	});

	it("keeps keys in memory, rotates without changing identity, defers running tasks and suppresses detached deletion", async () => {
		const f = fixture(); f.claude(); const before = readFileSync(join(f.home, ".claude/settings.json"), "utf8");
		const agentDir = join(f.home, "pi"), dataDir = join(f.home, "data");
		const mr = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
		const sync = new ModelSourceSync(dataDir, agentDir, f.options); let busy = false;
		const unbind = await sync.bind(mr, () => busy, () => {});
		try {
			const config = sync.configs()[0], pid = config.providerId;
			expect((await mr.getAvailable()).some(m => m.provider === pid)).toBe(true);
			expect((await mr.getAuth(pid))?.auth.apiKey).toBe("secret-one");
			expect(JSON.stringify(sync.configs())).not.toContain("secret-one");
			busy = true; f.claude("secret-two"); await sync.sync();
			expect((await mr.getAuth(pid))?.auth.apiKey).toBe("secret-one");
			busy = false; await sync.ready(mr); expect((await mr.getAuth(pid))?.auth.apiKey).toBe("secret-two");
			expect(sync.configs()[0].providerId).toBe(pid);
			if (process.platform !== "win32") expect(statSync(join(dataDir, "model-sources.json")).mode & 0o777).toBe(0o600);
			await sync.edit(pid, { ...config, compat: { supportsMessageThreads: true }, models: config.models.map(m => ({ ...m, compat: { supportsMessageThreads: false, promptCacheKeyMode: "disabled" } })) }); f.claude("secret-three"); await sync.sync();
			expect(sync.configs()[0].compat).toEqual({ supportsMessageThreads: true });
			expect(mr.getModel(pid, config.models[0].id)?.compat).toMatchObject({ supportsMessageThreads: false, promptCacheKeyMode: "disabled" });
			const local = sync.configs()[0];
			await sync.edit(pid, { ...local, models: local.models.map(m => ({ ...m, compat: { supportsMessageThreads: null } })) });
			expect(mr.getModel(pid, config.models[0].id)?.compat).toMatchObject({ supportsMessageThreads: true, promptCacheKeyMode: "disabled" });
			expect((await mr.getAuth(pid))?.auth.apiKey).toBe("secret-two");
			expect(sync.configs()[0].origin?.mode).toBe("local");
			await sync.edit(pid); await sync.sync(); expect(sync.configs()).toHaveLength(0);
			await sync.sync("claude", true, true); expect(sync.configs()).toHaveLength(1);
			await sync.sync("claude", false); expect(sync.configs()).toHaveLength(0);
			f.put(".claude/settings.json", before); await sync.sync("claude", true); expect(readFileSync(join(f.home, ".claude/settings.json"), "utf8")).toBe(before);
		} finally { unbind(); }
	});
	it("merges declared capabilities, isolates failures, and updates endpoints without changing identity", async () => {
		const f = fixture(); f.claude();
		const open = (bad = false, url = "https://api.anthropic.com") => f.put(".config/opencode/opencode.json", { provider: { anthropic: {
			options: { apiKey: "secret-one", baseURL: url },
			models: { "claude-example-1": { reasoning: true, modalities: { input: ["text", "image"] }, limit: { context: 200000, output: 8192 }, ...(bad ? { options: { unsupported: true } } : {}) }, healthy: {} },
		} } });
		open();
		const agentDir = join(f.home, "pi"), sync = new ModelSourceSync(join(f.home, "data"), agentDir, f.options);
		const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), authPath: join(agentDir, "auth.json"), allowModelNetwork: false });
		const unbind = await sync.bind(runtime, () => false, () => {});
		try {
			const merged = sync.configs().find(c => c.models[0].id === "claude-example-1")!;
			expect(merged.origin?.sources).toEqual(["claude", "opencode"]);
			expect(runtime.getModel(merged.providerId, "claude-example-1")).toMatchObject({ contextWindow: 200000, maxTokens: 65536, reasoning: true, input: ["text", "image"] });
			rmSync(join(f.home, ".claude/settings.json"));
			open(false, "https://new.example/v1"); await sync.sync();
			expect(runtime.getModel(merged.providerId, "claude-example-1")?.baseUrl).toBe("https://new.example/v1");
			open(true); await sync.sync();
			expect(sync.accepts(runtime, merged.providerId, "claude-example-1")).toBe(false);
			expect(sync.configs().map(c => c.models[0].id)).toEqual(["healthy"]);
			expect(sync.status(runtime).find(s => s.source === "opencode")).toMatchObject({ status: "partial", count: 1 });
			open(); await sync.sync();
			expect(sync.accepts(runtime, merged.providerId, "claude-example-1")).toBe(true);
		} finally { unbind(); }
	});

	it("merges exact external duplicates, retains their identity when a source disappears and splits accounts", async () => {
		const f = fixture();
		f.put(".codex/config.toml", 'model="same"\nmodel_provider="gateway"\n[model_providers.gateway]\nbase_url="http://localhost:9999/v1"\nwire_api="chat"\nenv_key="KEY"');
		const open = (key: string) => f.put(".config/opencode/opencode.json", { provider: { gateway: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:9999/v1", apiKey: key }, models: { same: {} } } } });
		open("shared"); const sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), { home: f.home, env: { KEY: "shared" } });
		const original = sync.configs()[0]; expect(sync.configs()).toHaveLength(1); expect(original.origin?.sources).toEqual(["codex", "opencode"]);
		rmSync(join(f.home, ".codex/config.toml")); await sync.sync(); expect(sync.configs()[0].providerId).toBe(original.providerId);
		const restored = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), { home: f.home, env: { KEY: "shared" } });
		expect(restored.configs()[0].providerId).toBe(original.providerId);
		f.put(".codex/config.toml", 'model="same"\nmodel_provider="gateway"\n[model_providers.gateway]\nbase_url="http://localhost:9999/v1"\nwire_api="chat"\nenv_key="KEY"');
		open("different-account"); await restored.sync(); expect(restored.configs()).toHaveLength(2);
	});
	it("does not lend default environment keys to custom OpenCode providers", () => {
		const f = fixture();
		f.put(".config/opencode/opencode.json", { provider: { gateway: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:9999/v1" }, models: { same: {} } } } });
		const r = discoverModels({ home: f.home, env: { OPENAI_API_KEY: "unrelated" } });
		expect(r.connections).toEqual([]);
		expect(r.statuses.find(s => s.source === "opencode")?.status).toBe("incomplete");
		f.put(".config/opencode/opencode.json", { model: "openai/same" });
		expect(discoverModels({ home: f.home, env: { OPENAI_API_KEY: "native-key" } }).connections[0].key).toBe("native-key");
	});
	it("preserves both issued identities through merge, restart, split and source deletion", async () => {
		const f = fixture();
		f.put(".codex/config.toml", 'model="same"\nmodel_provider="gateway"\n[model_providers.gateway]\nbase_url="http://localhost:9999/v1"\nwire_api="chat"\nenv_key="KEY"');
		const open = (apiKey: string) => f.put(".config/opencode/opencode.json", { provider: { gateway: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:9999/v1", apiKey }, models: { same: {} } } } });
		open("second");
		const options = { home: f.home, env: { KEY: "first" } }, agentDir = join(f.home, "pi"), dataDir = join(f.home, "data");
		let sync = new ModelSourceSync(dataDir, agentDir, options);
		const ids = sync.configs().map(c => c.providerId);
		open("first"); await sync.sync(); expect(sync.configs()).toHaveLength(1);
		sync = new ModelSourceSync(dataDir, agentDir, options);
		const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), authPath: join(agentDir, "auth.json"), allowModelNetwork: false });
		const unbind = await sync.bind(runtime, () => false, () => {});
		try {
			for (const id of ids) { expect(sync.accepts(runtime, id, "same")).toBe(true); expect((await runtime.getAuth(id))?.auth.apiKey).toBe("first"); }
			open("third"); await sync.sync(); expect(sync.configs()).toHaveLength(2);
			expect((await runtime.getAuth(ids[0]))?.auth.apiKey).toBe("first");
			expect((await runtime.getAuth(ids[1]))?.auth.apiKey).toBe("third");
			open("first"); await sync.sync(); rmSync(join(f.home, ".codex/config.toml")); await sync.sync();
			for (const id of ids) expect(sync.accepts(runtime, id, "same")).toBe(true);
			const config = sync.configs()[0]; await sync.edit(config.providerId, config);
			for (const id of ids) expect(sync.accepts(runtime, id, "same")).toBe(true);
			await sync.edit(config.providerId);
			for (const id of ids) expect(sync.accepts(runtime, id, "same")).toBe(false);
		} finally { unbind(); }
	});
	it.each(["models", "credentials"])("retains native history after Pi %s disappear, including restart", async removal => {
		const f = fixture(); f.claude("shared");
		f.put("pi/models.json", { providers: { native: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: [{ id: "claude-example-1", contextWindow: 32768, maxTokens: 32768, reasoning: false, input: ["text", "image"] }, { id: "unrelated", contextWindow: 32768, maxTokens: 4096, reasoning: false, input: ["text"] }] } } });
		f.put("pi/auth.json", { native: { type: "api_key", key: "shared" } });
		const options = { modelsPath: join(f.home, "pi/models.json"), authPath: join(f.home, "pi/auth.json"), allowModelNetwork: false };
		const nativeConfig = readFileSync(options.modelsPath, "utf8");
		let runtime = await ModelRuntime.create(options), sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), f.options);
		let unbind = await sync.bind(runtime, () => false, () => {});
		try {
			expect(sync.origin("native").sources).toEqual(["pi", "claude"]);
			expect(runtime.getModel(sync.configs()[0].providerId, "claude-example-1")?.contextWindow).toBe(32768);
			await sync.sync();
			expect(sync.configs()[0].models[0].contextWindow).toBe(32768);
			if (removal === "models") rmSync(options.modelsPath); else f.put("pi/auth.json", {});
			await sync.sync();
			expect(sync.accepts(runtime, "native", "claude-example-1")).toBe(true);
			unbind();
			runtime = await ModelRuntime.create(options); sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), f.options);
			unbind = await sync.bind(runtime, () => false, () => {});
			expect(sync.accepts(runtime, "native", "claude-example-1")).toBe(true);
			expect((await runtime.getAvailable()).some(m => m.provider === "native" && m.id === "claude-example-1")).toBe(true);
			expect(readFileSync(join(f.home, "data/model-sources.json"), "utf8")).not.toContain("shared");
			expect(sync.accepts(runtime, "native", "unrelated")).toBe(false);
			expect((await runtime.getAvailable()).some(m => m.provider === "native" && m.id === "unrelated")).toBe(false);
			// Intercept at the target runtime boundary: no network, and no marker/native auth leaks.
			const stream = vi.spyOn(runtime, "streamSimple").mockImplementation(() => { throw new Error("captured"); });
			const provider = runtime.getProvider("native")!, model = runtime.getModel("native", "claude-example-1")!;
			try { await provider.streamSimple(model, normalizeContext({ messages: [] }), { apiKey: "old-native-key", headers: { Authorization: "old" } }).result(); } catch { /* Direct provider dispatch or composed lazy stream. */ }
			expect(stream.mock.calls[0][0].provider).toBe(sync.configs()[0].providerId);
			expect(stream.mock.calls[0][2]).not.toHaveProperty("apiKey"); expect(stream.mock.calls[0][2]).not.toHaveProperty("headers");
			stream.mockRestore();
			rmSync(join(f.home, ".claude/settings.json"));
			// SDK registration refreshes can temporarily clear the snapshot. Historical
			// admission must not depend on capturing the fallback in that snapshot.
			const snapshot = vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValueOnce([]);
			try { await sync.sync(); } finally { snapshot.mockRestore(); }
			expect(sync.accepts(runtime, "native", "claude-example-1")).toBe(false);
			f.put("pi/models.json", nativeConfig); f.put("pi/auth.json", { native: { type: "api_key", key: "restored-native" } }); await sync.sync();
			expect(sync.accepts(runtime, "native", "claude-example-1")).toBe(true);
			expect(runtime.getRegisteredNativeProvider("native")).toBeUndefined();
			expect((await runtime.getAuth("native"))?.auth.apiKey).toBe("restored-native");
		} finally { unbind(); }
	});

	it("keeps the existing Pi identity for an exact native duplicate", async () => {
		const f = fixture(); f.claude("shared");
		f.put("pi/models.json", { providers: { native: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", apiKey: "shared", models: [{ id: "claude-example-1", contextWindow: 200000, maxTokens: 65536, reasoning: false, input: ["text", "image"] }] } } });
		const runtime = await ModelRuntime.create({ modelsPath: join(f.home, "pi/models.json"), authPath: join(f.home, "pi/auth.json") });
		const sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), f.options);
		const unbind = await sync.bind(runtime, () => false, () => {});
		try {
			expect(sync.visible("native")).toBe(true);
			expect(sync.visible(sync.configs()[0].providerId)).toBe(false);
			expect(sync.origin("native").sources).toEqual(["pi", "claude"]);
			expect(runtime.getModel(sync.configs()[0].providerId, "claude-example-1")?.contextWindow).toBe(200000);
			await sync.sync();
			expect(sync.configs()[0].models[0].contextWindow).toBe(200000);
			f.claude("different-account"); await sync.sync();
			rmSync(join(f.home, "pi/models.json")); await sync.sync();
			expect(sync.accepts(runtime, "native", "claude-example-1")).toBe(false);
		} finally { unbind(); }
	});
	it("passes runtime keys and header dollar signs literally to the SDK", async () => {
		const f = fixture(); f.put(".claude/settings.json", { model: "claude-example", env: { ANTHROPIC_API_KEY: "!this-is-a-literal-key", ANTHROPIC_CUSTOM_HEADERS: "x-literal: $HOME" } });
		const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(f.home, "pi/auth.json") });
		const sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), f.options);
		const unbind = await sync.bind(runtime, () => false, () => {});
		try {
			const pid = sync.configs()[0].providerId;
			const auth = await runtime.getAuth(runtime.getModel(pid, "claude-example")!);
			expect(auth?.auth.apiKey).toBe("!this-is-a-literal-key"); expect(auth?.auth.headers?.["x-literal"]).toBe("$HOME");
		} finally { unbind(); }
	});

	it("keeps Anthropic bearer tokens in header-owned auth without an API key", async () => {
		const f = fixture(); f.put(".claude/settings.json", { model: "claude-example", env: { ANTHROPIC_AUTH_TOKEN: "api-bearer-secret" } });
		const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(f.home, "pi/auth.json") });
		const sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), f.options);
		const unbind = await sync.bind(runtime, () => false, () => {});
		try {
			const entry = sync.configs()[0];
			const auth = await runtime.getAuth(runtime.getModel(entry.providerId, "claude-example")!);
			expect(auth?.auth.apiKey).toBeUndefined(); expect(auth?.auth.headers?.Authorization).toBe("Bearer api-bearer-secret");
			await sync.edit(entry.providerId, { ...entry, apiKey: "rotated-bearer" });
			expect((await runtime.getAuth(entry.providerId))?.auth.headers?.Authorization).toBe("Bearer rotated-bearer");
		} finally { unbind(); }
	});

	it("disables damaged/deleted sources while retaining other sources", async () => {
		const f = fixture(); f.claude(); f.put(".codex/config.toml", 'model="gpt-test"'); f.put(".codex/auth.json", { OPENAI_API_KEY: "secret" });
		const sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), f.options);
		expect(sync.configs()).toHaveLength(2); f.put(".claude/settings.json", "{"); await sync.sync();
		expect(sync.configs()).toHaveLength(1); rmSync(join(f.home, ".codex/auth.json")); await sync.sync(); expect(sync.configs()).toHaveLength(0);
	});
});

it("applies the default output floor to synced and independent models", async () => {
	const f = fixture(); f.claude();
	const runtime = await ModelRuntime.create({ authPath: join(f.home, "pi/auth.json"), modelsPath: join(f.home, "pi/models.json"), allowModelNetwork: false });
	const sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), { home: f.home, env: {} });
	const unbind = await sync.bind(runtime, () => false, () => {});
	try {
		const config = sync.configs()[0];
		expect(config.models[0].maxTokens).toBe(32768);
		expect(runtime.getModel(config.providerId, config.models[0].id)?.maxTokens).toBe(32768);
		await sync.edit(config.providerId, { ...config, models: [{ ...config.models[0], maxTokens: 2048 }] });
		expect(sync.configs()[0].models[0].maxTokens).toBe(32768);
		expect(runtime.getModel(config.providerId, config.models[0].id)?.maxTokens).toBe(32768);
	} finally { unbind(); }
});

it.each(["", "0", "-1", "NaN", "Infinity", "1.5", "9007199254740992"])("ignores disabled/invalid floor %s", floor => {
	const f = fixture(); f.claude();
	const sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), { home: f.home, env: { PI_MAX_TOKENS_FLOOR: floor } });
	expect(sync.configs()[0].models[0].maxTokens).toBe(4096);
});

it("caps the floor at context size and preserves provider identities and source files", async () => {
	const f = fixture(); f.claude();
	const file = join(f.home, ".claude/settings.json"), original = readFileSync(file, "utf8");
	const env = { PI_MAX_TOKENS_FLOOR: "0" };
	const sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), { home: f.home, env });
	const id = sync.configs()[0].providerId;
	env.PI_MAX_TOKENS_FLOOR = "999999"; await sync.sync();
	expect(sync.configs()[0].providerId).toBe(id);
	expect(sync.configs()[0].models[0].maxTokens).toBe(sync.configs()[0].models[0].contextWindow);
	expect(readFileSync(file, "utf8")).toBe(original);
});

it("does not let native capability completion erase the configured synced floor", async () => {
	const f = fixture(); f.claude("shared");
	f.put("pi/models.json", { providers: { native: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", apiKey: "shared", models: [{ id: "claude-example-1", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096 }] } } });
	const runtime = await ModelRuntime.create({ authPath: join(f.home, "pi/auth.json"), modelsPath: join(f.home, "pi/models.json"), allowModelNetwork: false });
	const sync = new ModelSourceSync(join(f.home, "data"), join(f.home, "pi"), { home: f.home, env: { PI_MAX_TOKENS_FLOOR: "16384" } });
	const unbind = await sync.bind(runtime, () => false, () => {});
	try {
		const config = sync.configs()[0];
		expect(config.models[0].maxTokens).toBe(16384);
		expect(sync.visible(config.providerId)).toBe(true);
		expect(runtime.getModel("native", "claude-example-1")?.maxTokens).toBe(4096);
		expect(runtime.getModel("native", "claude-example-1")?.input).toEqual(["text"]);
		expect(runtime.getModel(config.providerId, "claude-example-1")?.input).toEqual(["text", "image"]);
		expect(sync.origin("native").sources).toEqual(["pi"]);
	} finally { unbind(); }
});
