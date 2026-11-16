import { parseTree, type Node } from "jsonc-parser";
import { ompMcpServers } from "./omp-mcp-edit.js";

type Document = Record<string, unknown>;
type Format = "native" | "vscode" | "opencode-v1" | "opencode-v2";
type ErrorKey = "ompMcpImportInvalid" | "ompMcpImportUnsupported" | "ompMcpImportConflict" | "ompMcpImportVariable";
export class OmpMcpImportError extends Error {
	constructor(readonly key: ErrorKey) { super(key); }
}
function fail(key: ErrorKey = "ompMcpImportInvalid"): never { throw new OmpMcpImportError(key); }
const record = (value: unknown): value is Document => value !== null && typeof value === "object" && !Array.isArray(value);
const stringMap = (value: unknown) => record(value) && Object.values(value).every(item => typeof item === "string");
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const allowed = (value: Document, keys: string[]) => { if (Object.keys(value).some(key => !keys.includes(key))) fail("ompMcpImportUnsupported"); };
const base = ["type", "enabled", "timeout", "instructions", "requestIdFormat"];
const stdio = ["command", "args", "cwd", "env"];
const remote = ["url", "headers", "oauth"];

// Reject duplicate keys before JSON.parse can silently discard a definition.
function checkTree(node: Node, depth = 0): void {
	if (depth > 32) fail();
	if (node.type === "object") {
		const keys = new Set<string>();
		for (const property of node.children ?? []) {
			const key = property.children?.[0].value;
			if (keys.has(key) || key === "__proto__") fail();
			keys.add(key);
		}
	}
	for (const child of node.children ?? []) checkTree(child, depth + 1);
}

function variable(value: string, format: Format): string {
	if (value === "••••••••") fail("ompMcpImportVariable");
	let result = value;
	if (format === "vscode") result = result.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => "${" + name + "}");
	if (format.startsWith("opencode")) result = result.replace(/(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => "${" + name + "}");
	// Only native braced environment references are portable. Never resolve them
	// in the browser, nor turn input/file/config placeholders into literal secrets.
	const rest = result.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^{}]*)?\}/g, token => {
		if (/^\$\{(?:workspaceFolder|workspaceRoot|userHome)(?::|\})/.test(token)) fail("ompMcpImportVariable");
		return "";
	});
	if (/\$\{|\{(?:env|file|input|config):/.test(rest)) fail("ompMcpImportVariable");
	return result;
}

function convert(source: Document, format: Format): Document {
	let config = { ...source };
	if (format.startsWith("opencode")) {
		const v2 = format === "opencode-v2";
		allowed(config, ["type", "command", "cwd", "environment", "url", "headers", v2 ? "disabled" : "enabled", ...(v2 ? [] : ["timeout"])]);
		if (!["local", "remote"].includes(String(config.type))) fail();
		if (v2 && config.disabled !== undefined) {
			if (typeof config.disabled !== "boolean") fail();
			config.enabled = !config.disabled; delete config.disabled;
		}
		if (config.type === "local") {
			if (!strings(config.command) || !config.command.length) fail();
			config.args = config.command.slice(1); config.command = config.command[0]; config.type = "stdio";
			if (config.environment !== undefined) { config.env = config.environment; delete config.environment; }
		} else config.type = "http";
	} else if (format === "vscode") {
		allowed(config, ["type", "command", "args", "cwd", "env", "url", "headers"]);
	}
	const type = config.type ?? (config.url !== undefined ? "http" : "stdio");
	if (!["stdio", "http", "sse"].includes(String(type))) fail();
	config.type = type;
	allowed(config, [...base, ...(type === "stdio" ? stdio : remote)]);
	const required = type === "stdio" ? config.command : config.url;
	if (typeof required !== "string" || !required.trim()) fail();
	for (const key of ["command", "url", "cwd"]) if (config[key] !== undefined && typeof config[key] !== "string") fail();
	for (const key of ["enabled", "instructions"]) if (config[key] !== undefined && typeof config[key] !== "boolean") fail();
	for (const key of ["args"]) if (config[key] !== undefined && !strings(config[key])) fail();
	for (const key of ["env", "headers"]) if (config[key] !== undefined && !stringMap(config[key])) fail();
	if (config.timeout !== undefined && (typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout < 0)) fail();
	if (config.requestIdFormat !== undefined && !["number", "string"].includes(String(config.requestIdFormat))) fail();
	if (config.oauth !== undefined) {
		if (!record(config.oauth)) fail("ompMcpImportUnsupported");
		allowed(config.oauth, ["clientId", "clientSecret", "scope", "redirectUri", "callbackPort", "callbackPath", "prompt"]);
		for (const [key, value] of Object.entries(config.oauth)) {
			if (key === "callbackPort" ? !Number.isInteger(value) || Number(value) < 0 || Number(value) > 65535 : typeof value !== "string") fail();
		}
	}
	const map = (value: unknown): unknown => {
		if (typeof value === "string") return variable(value, format);
		if (Array.isArray(value)) return value.map(map);
		if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, map(item)]));
		return value;
	};
	return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, map(value)]));
}

export interface OmpMcpImportPreview {
	format: Format;
	names: string[];
	document: Document;
}

/** Atomic, append-only draft conversion. Saving still uses the native writer's CAS. */
export function previewOmpMcpImport(current: Document, text: string): OmpMcpImportPreview {
	if (text.length > 1024 * 1024) fail();
	let tree: Node | undefined;
	try { tree = parseTree(text); } catch { return fail(); }
	if (!tree) fail(); checkTree(tree);
	let value: unknown; try { value = JSON.parse(text); } catch { return fail(); }
	if (!record(value)) fail();
	const roots = ["mcpServers", "servers", "mcp"].filter(key => Object.hasOwn(value, key));
	if (roots.length !== 1) fail();
	let source = value[roots[0]], format: Format = roots[0] === "mcpServers" ? "native" : roots[0] === "servers" ? "vscode" : "opencode-v1";
	if (!record(source)) fail();
	if (format === "native") allowed(value, ["$schema", "mcpServers", "enabledServers", "disabledServers"]);
	if (format === "vscode") allowed(value, ["$schema", "servers"]);
	if (format === "opencode-v1" && Object.hasOwn(source, "servers")) {
		allowed(source, ["servers"]); source = source.servers; format = "opencode-v2";
		if (!record(source)) fail();
	}
	const existing = ompMcpServers(current), names = Object.keys(source);
	if (!names.length || names.length + Object.keys(existing).length > 256) fail();
	for (const name of names) {
		if (name.length > 100 || !/^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$/.test(name)) fail();
		if (Object.hasOwn(existing, name)) fail("ompMcpImportConflict");
	}
	for (const key of ["enabledServers", "disabledServers"]) {
		const target = current[key];
		if (target !== undefined && !strings(target)) fail();
		if (strings(target) && target.some(name => names.includes(name))) fail("ompMcpImportConflict");
		const rules = value[key];
		if (rules !== undefined && (format !== "native" || !strings(rules) || rules.some(name => !names.includes(name)))) fail("ompMcpImportUnsupported");
	}
	const additions = Object.fromEntries(Object.entries(source).map(([name, entry]) => {
		if (!record(entry)) fail();
		const config = convert(entry, format);
		if (strings(value.enabledServers) && value.enabledServers.includes(name)) config.enabled = true;
		if (strings(value.disabledServers) && value.disabledServers.includes(name)) config.enabled = false;
		return [name, config];
	}));
	return { format, names, document: { ...current, mcpServers: { ...existing, ...additions } } };
}
