import { describe, expect, it } from "vitest";
import { previewOmpMcpImport } from "../../web/src/omp-mcp-import.js";

const preview = (value: unknown, current = {}) => previewOmpMcpImport(current, JSON.stringify(value));
describe("OMP MCP append-only import", () => {
	it("preserves existing masks and unknown fields, folding source enable precedence into new definitions", () => {
		const current = { future: { secret: "••••••••" }, mcpServers: { old: { command: "••••••••" } }, disabledServers: ["other"] };
		const before = structuredClone(current);
		const result = preview({ mcpServers: { new: { command: "node", enabled: true, requestIdFormat: "string", instructions: false } }, enabledServers: ["new"], disabledServers: ["new"] }, current);
		expect(result.document).toEqual({ ...current, mcpServers: { ...current.mcpServers, new: { type: "stdio", command: "node", enabled: false, requestIdFormat: "string", instructions: false } } });
		expect(current).toEqual(before);
	});
	it("converts VS Code env references once and leaves OMP defaults intact", () => {
		const result = preview({ servers: { api: { url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${env:KEY}", Fallback: "${KEY:-default}" } } } });
		expect(result.document).toEqual({ mcpServers: { api: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${KEY}", Fallback: "${KEY:-default}" } } } });
	});
	it("converts OpenCode v1 and v2 command arrays and disable flags without importing other product settings", () => {
		for (const v2 of [false, true]) {
			const entry = { type: "local", command: ["node", "two words", "{env:ARG}"], cwd: "/work", environment: { KEY: "{env:KEY}" }, ...(v2 ? { disabled: true } : { enabled: false, timeout: 0 }) };
			const result = preview({ model: "ignored-product-setting", mcp: v2 ? { servers: { local: entry } } : { local: entry } });
			expect(result.format).toBe(v2 ? "opencode-v2" : "opencode-v1");
			expect(result.document).toEqual({ mcpServers: { local: { type: "stdio", command: "node", args: ["two words", "${ARG}"], cwd: "/work", env: { KEY: "${KEY}" }, enabled: false, ...(v2 ? {} : { timeout: 0 }) } } });
		}
		expect(preview({ mcp: { servers: { remote: { type: "remote", url: "https://example.invalid", disabled: false } } } }).document).toEqual({ mcpServers: { remote: { type: "http", url: "https://example.invalid", enabled: true } } });
	});
	it("refuses all additions if any name collides with a definition or target discovery rule", () => {
		const value = { mcpServers: { first: { command: "node" }, collision: { command: "node" } } };
		for (const current of [{ mcpServers: { collision: { command: "old" } } }, { enabledServers: ["collision"] }, { disabledServers: ["collision"] }]) {
			const before = structuredClone(current);
			expect(() => preview(value, current)).toThrow("ompMcpImportConflict"); expect(current).toEqual(before);
		}
		expect(() => preview({ ...value, disabledServers: ["absent"] })).toThrow("ompMcpImportUnsupported");
	});
	it("does not silently drop foreign features or authentication semantics", () => {
		for (const option of [{ oauth: false }, { timeout: { execution: 1000 } }, { codemode: false }, { protocol: "auto" }, { pool: true }, { enabled: true }]) {
			expect(() => preview({ mcp: { servers: { api: { type: "remote", url: "https://example.invalid", ...option } } } })).toThrow("ompMcpImportUnsupported");
		}
		for (const option of [{ envFile: "secret.env" }, { dev: {} }, { sandbox: {} }, { env: { REMOVE: null } }]) {
			expect(() => preview({ servers: { local: { command: "node", ...option } } })).toThrow();
		}
		expect(() => preview({ servers: { local: { command: "node" } }, inputs: [] })).toThrow("ompMcpImportUnsupported");
		expect(() => preview({ mcp: { servers: { local: { type: "local", command: ["node"] } }, timeout: {} } })).toThrow("ompMcpImportUnsupported");
		expect(() => preview({ mcpServers: { local: { command: "node", auth: { credentialId: "private" } } } })).toThrow("ompMcpImportUnsupported");
	});
	it("rejects unresolved placeholders and plugin-only literal policies instead of silently losing their semantics", () => {
		for (const value of ["${input:PRIVATE}", "${workspaceFolder}/file", "${config:PRIVATE}", "{file:PRIVATE}", "••••••••", "${env:PRIVATE}"]) {
			expect(() => preview({ mcpServers: { local: { command: "node", args: [value] } } })).toThrow(/^ompMcpImportVariable$/);
		}
		for (const policy of [{ envPolicy: "literal" }, { envLiteralKeys: ["KEY"] }]) {
			expect(() => preview({ mcpServers: { local: { command: "node", ...policy } } })).toThrow("ompMcpImportUnsupported");
		}
		expect(() => preview({ mcpServers: { api: { url: "https://example.invalid", headerPolicy: "origin-locked" } } })).toThrow("ompMcpImportUnsupported");
	});
	it("rejects ambiguous roots, duplicate JSON keys, invalid shapes and excessive nesting or size", () => {
		for (const value of [{}, { mcpServers: {}, servers: {} }, { mcpServers: [] }, { mcpServers: { a: { command: "node", url: "https://example.invalid" } } }, { mcpServers: { a: { command: "node", args: [1] } } }]) expect(() => preview(value)).toThrow();
		for (const raw of ['{"mcpServers":{"a":{"command":"secret","command":"node"}}}', '{"mcpServers":{},"mcpServers":{}}', '{"mcpServers":{"a":{"command":"SECRET', '['.repeat(100) + ']'.repeat(100), ' '.repeat(1048577)]) expect(() => previewOmpMcpImport({}, raw)).toThrow(/^ompMcpImportInvalid$/);
	});
	it("treats object-like names as data and preserves native OAuth configuration", () => {
		const document = JSON.parse('{"mcpServers":{"constructor":{"type":"sse","url":"https://example.invalid","oauth":{"clientId":"${CLIENT}","callbackPort":12345}}}}');
		const result = preview(document);
		expect(result.names).toEqual(["constructor"]);
		expect(() => previewOmpMcpImport({}, '{"mcpServers":{"__proto__":{"command":"node"}}}')).toThrow("ompMcpImportInvalid");
		expect(Object.keys(result.document.mcpServers!)).toEqual(result.names);
		expect(Object.getPrototypeOf(result.document.mcpServers)).toBe(Object.prototype);
		expect(result.document.mcpServers).toMatchObject(document.mcpServers);
	});
});
