import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mcpNamespaceKey } from "../../server/mcp-namespace.js";
import { NativeMcpConfigService } from "../../server/native-mcp-config.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-mcp-namespace-")), agent = join(root, "agent");
	roots.push(root); mkdirSync(agent); vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	return { root, agent, service: new NativeMcpConfigService() };
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("matches native hyphen and underscore namespaces", () => {
	expect(mcpNamespaceKey("playwright-extension")).toBe(mcpNamespaceKey("playwright_extension"));
	expect(mcpNamespaceKey("other-server")).not.toBe(mcpNamespaceKey("playwright_extension"));
});

it("rejects a same-file namespace conflict before writing", () => {
	const { root, service } = fixture(), initial = service.get(root, "global");
	expect(() => service.save(root, "global", initial.version, { mcpServers: {
		"playwright-extension": { command: "npx" },
		playwright_extension: { command: "npx" },
	} })).toThrow(/namespace conflict/);
	expect(() => readFileSync(initial.path, "utf8")).toThrow(/ENOENT/);
});

it("rejects a project entry that conflicts with a global browser alias", () => {
	const { root, agent, service } = fixture();
	writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { playwright_extension: { command: "npx", enabled: false } } }));
	const initial = service.get(root, "project");
	expect(() => service.save(root, "project", initial.version, { mcpServers: { "playwright-extension": { enabled: true } } })).toThrow(/namespace conflict/);
	const saved = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8"));
	expect(Object.keys(saved.mcpServers)).toEqual(["playwright_extension"]);
});
