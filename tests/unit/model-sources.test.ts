import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { discoverModels } from "../../server/model-sources.js";
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

});
