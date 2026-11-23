import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mcpNamespaceKey } from "../../server/mcp-namespace.js";
import { loadHarnessMcpConfig, NativeMcpConfigService } from "../../server/native-mcp-config.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-mcp-namespace-")), agent = join(root, "agent");
	roots.push(root); mkdirSync(agent); vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	return { root, agent, service: new NativeMcpConfigService() };
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("matches native hyphen and underscore namespaces", () => {
	expect(mcpNamespaceKey("echo-server")).toBe(mcpNamespaceKey("echo_server"));
	expect(mcpNamespaceKey("other-server")).not.toBe(mcpNamespaceKey("echo_server"));
});

it("rejects a same-file namespace conflict before writing", () => {
	const { root, service } = fixture(), initial = service.get(root, "global");
	expect(() => service.save(root, "global", initial.version, { mcpServers: {
		"echo-server": { command: "npx" },
		echo_server: { command: "npx" },
	} })).toThrow(/namespace conflict/);
	expect(() => readFileSync(initial.path, "utf8")).toThrow(/ENOENT/);
});

it("rejects a project entry that conflicts with a global namespace alias", () => {
	const { root, agent, service } = fixture();
	writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { echo_server: { command: "npx", enabled: false } } }));
	const initial = service.get(root, "project");
	expect(() => service.save(root, "project", initial.version, { mcpServers: { "echo-server": { enabled: true } } })).toThrow(/namespace conflict/);
	const saved = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8"));
	expect(Object.keys(saved.mcpServers)).toEqual(["echo_server"]);
});

it("ignores both retired names on startup, reload and settings saves while retaining unrelated MCPs", () => {
	const { root, agent, service } = fixture();
	mkdirSync(join(root, ".pi"));
	const legacy = { command: "npx", enabled: true };
	writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { "playwright-extension": legacy, echo: { command: "echo" } } }));
	writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { playwright_extension: legacy, project: { command: "echo" } } }));
	expect(loadHarnessMcpConfig(root, false).servers.map(s => s.name)).toEqual(["echo"]);
	expect(loadHarnessMcpConfig(root, true).servers.map(s => s.name).sort()).toEqual(["echo", "project"]);
	const initial = service.get(root, "global");
	expect(Object.keys(initial.document.mcpServers!)).toEqual(["echo"]);
	service.save(root, "global", initial.version, { ...initial.document, autoEnableCodemode: false });
	expect(JSON.parse(readFileSync(initial.path, "utf8")).mcpServers["playwright-extension"]).toEqual(legacy);
	expect(loadHarnessMcpConfig(root, true).autoEnableCodemode).toBe(false);
});
