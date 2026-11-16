import { describe, expect, it } from "vitest";
import { ompMcpForm, removeOmpMcpServer, saveOmpMcpForm } from "../../web/src/omp-mcp-edit.js";

describe("OMP service form drafts", () => {
	it("preserves masked credentials at their original paths and all unedited native fields", () => {
		const original = { custom: { value: "••••••••" }, mcpServers: { api: { type: "http", url: "••••••••", headers: { Authorization: "••••••••" }, oauth: { clientSecret: "••••••••" }, requestIdFormat: "string", instructions: false } } };
		const before = structuredClone(original), form = ompMcpForm(original, "api", "global");
		form.timeout = "0";
		expect(saveOmpMcpForm(original, form, "api", "global")).toEqual({ ...original, mcpServers: { api: { ...original.mcpServers.api, timeout: 0 } } });
		expect(original).toEqual(before);
		form.name = "renamed";
		expect(() => saveOmpMcpForm(original, form, "api", "global")).toThrow("ompMcpFormInvalid");
	});
	it("keeps global native precedence until an explicit enabled change and preserves other names", () => {
		const document = { mcpServers: { api: { type: "http", url: "••••••••", enabled: true } }, disabledServers: ["api", "other"], enabledServers: ["api", "forced"] };
		const form = ompMcpForm(document, "api", "global");
		expect(form.enabled).toBe("false");
		expect(saveOmpMcpForm(document, form, "api", "global")).toEqual(document);
		form.enabled = "true";
		expect(saveOmpMcpForm(document, form, "api", "global")).toMatchObject({ disabledServers: ["other"], enabledServers: ["forced", "api"] });
		form.enabled = "";
		expect(saveOmpMcpForm(document, form, "api", "global")).toEqual({ mcpServers: { api: { type: "http", url: "••••••••" } }, disabledServers: ["other"], enabledServers: ["forced"] });
	});
	it("project edits do not rewrite global-list fields or invent a default type", () => {
		const document = { mcpServers: { local: { command: "••••••••", args: ["••••••••"] } }, disabledServers: ["other"] };
		const form = ompMcpForm(document, "local", "project"); form.enabled = "false";
		expect(saveOmpMcpForm(document, form, "local", "project")).toEqual({ ...document, mcpServers: { local: { ...document.mcpServers.local, enabled: false } } });
	});
	it("type conversion removes conflicting transport fields and preserves unrelated settings", () => {
		const document = { mcpServers: { local: { command: "old", args: ["old"], env: { SECRET: "••••••••" }, cwd: "••••••••", instructions: false } } };
		const form = ompMcpForm(document, "local", "global"); form.type = "http"; form.url = "https://example.invalid/mcp";
		expect(saveOmpMcpForm(document, form, "local", "global")).toEqual({ mcpServers: { local: { type: "http", url: form.url, instructions: false } } });
	});
	it("rejects duplicate names, invalid maps and invalid JSON without echoing secrets", () => {
		const document = { mcpServers: { local: { command: "fixture" } } };
		const form = ompMcpForm(document, undefined, "global"); form.name = "local"; form.command = "fixture";
		expect(() => saveOmpMcpForm(document, form, undefined, "global")).toThrow("ompMcpFormExists");
		form.name = "New service"; form.env = '{"SECRET":"private-value';
		expect(() => saveOmpMcpForm(document, form, undefined, "global")).toThrow(/^ompMcpFormInvalid$/);
		form.env = '{"SECRET":123}';
		expect(() => saveOmpMcpForm(document, form, undefined, "global")).toThrow("ompMcpFormInvalid");
		form.env = ""; form.args = '{}';
		expect(() => saveOmpMcpForm(document, form, undefined, "global")).toThrow("ompMcpFormInvalid");
		form.args = ""; form.timeout = "Infinity";
		expect(() => saveOmpMcpForm(document, form, undefined, "global")).toThrow("ompMcpFormInvalid");
	});
	it("removal preserves unrelated discovery rules and handles object-like names as data", () => {
		const document = { mcpServers: { constructor: { command: "fixture" }, keep: { command: "keep" } }, disabledServers: ["constructor"] };
		expect(removeOmpMcpServer(document, "constructor")).toEqual({ mcpServers: { keep: { command: "keep" } }, disabledServers: ["constructor"] });
		expect(Object.keys(document.mcpServers)).toEqual(["constructor", "keep"]);
	});
});
