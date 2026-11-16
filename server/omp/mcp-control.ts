/** Bun-only MCP management using the SDK's own config writer and live manager. */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { validateServerName, writeMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { cfgMcpEnableProjectConfig, cfgMcpStartupTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { OmpMcpScope, UiOmpMcpRuntime, UiOmpMcpState } from "../protocol.js";
import { isRecord } from "./framing.js";

import { OmpMcpAuth } from "./mcp-auth.js";
import { OmpMcpDiagnostics } from "./mcp-diagnostics.js";

const MASK = "••••••••";
const LIMIT = 1024 * 1024;
const PUBLIC_ENUMS: Record<string, readonly string[]> = { type: ["stdio", "http", "sse"], requestIdFormat: ["number", "string"], envPolicy: ["literal"], headerPolicy: ["origin-locked"] };
export class OmpMcpError extends Error {}
function fail(message: string): never { throw new OmpMcpError(message); }
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

// Connection strings, arguments, credentials and unknown string fields stay
// on the host. A placeholder restores only the same location in the old file.
function transform(value: unknown, old: unknown, masking: boolean, path: string[] = []): unknown {
	if (path.length > 32) return fail("MCP configuration is too deeply nested");
	if (!masking && value === MASK) {
		if (old === undefined) return fail("A masked value has no existing value at this location");
		return old;
	}
	if (Array.isArray(value)) return value.map((item, index) => transform(item, Array.isArray(old) ? old[index] : undefined, masking, [...path, String(index)]));
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transform(item, isRecord(old) && Object.hasOwn(old, key) ? old[key] : undefined, masking, [...path, key])]));
	// A server's display name may itself contain "env" or "secret". Expose
	// only known non-secret metadata values, regardless of that name. Unknown
	// strings in enum fields remain masked just like other unknown fields.
	if (masking && path.length === 3 && path[0] === "mcpServers") {
		const key = path[2];
		if (typeof value === "string" && Object.hasOwn(PUBLIC_ENUMS, key) && PUBLIC_ENUMS[key].includes(value)) return value;
		if (typeof value === "boolean" && ["enabled", "instructions"].includes(key)) return value;
		if (typeof value === "number" && key === "timeout" && Number.isFinite(value) && value >= 0) return value;
	}
	const isServerList = path.length === 2 && ["disabledServers", "enabledServers"].includes(path[0]);
	if (masking && value !== null && value !== undefined && path.some(key => /secret|token|password|apiKey|headers|env/i.test(key))) return MASK;
	if (masking && typeof value === "string" && value && !isServerList) return MASK;
	return value;
}

function validate(document: unknown): asserts document is Record<string, unknown> {
	if (!isRecord(document) || JSON.stringify(document).length > LIMIT) fail("Invalid or oversized MCP configuration");
	const servers = document.mcpServers ?? {};
	if (!isRecord(servers) || Object.keys(servers).length > 256) fail("Invalid MCP server map");
	for (const key of ["disabledServers", "enabledServers"]) {
		const value = document[key];
		if (value !== undefined && (!Array.isArray(value) || value.length > 1000 || value.some(item => typeof item !== "string" || validateServerName(item)))) fail("Invalid MCP server list");
	}
	for (const [name, config] of Object.entries(servers)) {
		if (validateServerName(name) || !isRecord(config)) fail("Invalid MCP server name or configuration");
		for (const key of ["command", "url", "cwd", "type"]) if (config[key] !== undefined && typeof config[key] !== "string") fail("Invalid MCP connection field");
		for (const key of ["enabled", "instructions"]) if (config[key] !== undefined && typeof config[key] !== "boolean") fail("Invalid MCP boolean setting");
		if (config.timeout !== undefined && (typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout < 0)) fail("Invalid MCP timeout");
		if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string"))) fail("Invalid MCP command arguments");
		for (const key of ["env", "headers"]) if (config[key] !== undefined && (!isRecord(config[key]) || Object.values(config[key]).some(value => typeof value !== "string"))) fail("Invalid MCP environment or headers");
		if (validateServerConfig(name, config as unknown as MCPServerConfig).length) fail("OMP rejected the MCP server configuration");
	}
}

export class OmpMcpControl {
	private loaded?: string;
	readonly auth: OmpMcpAuth;
	private diagnostics: OmpMcpDiagnostics;
	constructor(private session: AgentSession, private manager: MCPManager | undefined, private cancelled: () => boolean) {
		this.auth = new OmpMcpAuth(session, manager, cancelled);
		this.diagnostics = new OmpMcpDiagnostics(manager);
	}
	dispose() { this.diagnostics.dispose(); return this.auth.close(); }
	private path(scope: unknown) {
		if (scope !== "global" && scope !== "project") return fail("Invalid MCP configuration scope");
		return getMCPConfigPath(scope === "global" ? "user" : "project", this.session.settings.getCwd());
	}
	private async raw(scope: unknown) {
		const path = this.path(scope);
		try {
			if (await realpath(dirname(path)) !== resolve(dirname(path))) fail("MCP configuration directory must not be a symlink");
			const stat = await lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) fail("MCP configuration must be a regular file of at most 1 MiB");
			const raw = await readFile(path, "utf8");
			if (Buffer.byteLength(raw) > LIMIT) fail("MCP configuration exceeds 1 MiB");
			return { path, raw };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, raw: "" };
			throw error;
		}
	}
	private parse(raw: string): Record<string, unknown> {
		let document: unknown;
		try { document = raw ? JSON.parse(raw) : { mcpServers: {} }; } catch { return fail("Invalid MCP JSON; repair the native file before continuing"); }
		if (!isRecord(document)) return fail("MCP configuration must be an object");
		return document;
	}
	private async fingerprint() { return hash((await this.raw("global")).raw + "\0" + (await this.raw("project")).raw); }
	async initialize() { await this.diagnostics.initialize(); this.loaded = await this.fingerprint().catch(() => undefined); }
	async status(): Promise<UiOmpMcpRuntime> {
		return { auth: this.auth.state, diagnostics: this.diagnostics.snapshot, workerAvailable: true, available: !!this.manager, projectConfigEnabled: cfgMcpEnableProjectConfig.get(this.session.settings), reloadRequired: this.loaded !== await this.fingerprint().catch(() => undefined),
			servers: (this.manager?.getAllServerNames() ?? []).slice(0, 1000).map(name => ({ name, ...this.auth.serverState(name), failure: this.diagnostics.failure(name), status: this.manager!.getConnectionStatus(name), source: this.manager!.getSource(name)?.path, tools: (this.manager!.getConnection(name)?.tools ?? []).slice(0, 1000).map(tool => tool.name) })) };
	}
	async get(scope: unknown): Promise<UiOmpMcpState> {
		const { path, raw } = await this.raw(scope);
		const document = this.parse(raw);
		return { ...await this.status(), config: { scope: scope as OmpMcpScope, path, version: hash(raw), document: transform(document, undefined, true) as Record<string, unknown> } };
	}
	private assertIdle() { if (this.auth.active || this.cancelled() || this.session.isStreaming || this.session.isDisposed) fail("Stop the current task before changing MCP"); }
	async save(scope: unknown, version: unknown, incoming: unknown) {
		this.assertIdle();
		if (!isRecord(incoming) || JSON.stringify(incoming).length > LIMIT) fail("Invalid or oversized MCP configuration");
		const path = this.path(scope);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await this.raw(scope);
		await withFileLock(path, async () => {
			this.assertIdle();
			const { raw } = await this.raw(scope);
			if (hash(raw) !== version) fail("MCP configuration changed; reload before saving");
			const document = transform(incoming, this.parse(raw), false);
			validate(document); this.assertIdle();
			await writeMCPConfigFile(path, document);
		});
		return this.get(scope);
	}
	async reload() {
		this.assertIdle();
		if (!this.manager) return fail("Native MCP manager unavailable");
		await this.session.settings.reloadFromDisk();
		await this.manager.reconcileProjectConfig(cfgMcpEnableProjectConfig.get(this.session.settings));
		this.assertIdle();
		// Match the native TUI reload, retaining its project/browser/plugin filters.
		await this.manager.disconnectAll(); this.assertIdle();
		this.session.setMCPPromptCommands([]); clearCache();
		const fingerprint = await this.fingerprint();
		await this.manager.discoverAndConnect({ enableProjectConfig: cfgMcpEnableProjectConfig.get(this.session.settings), filterExa: true,
			filterBrowser: this.session.getEvalPreludes().some(item => item.name === "browser"), extensionRoots: this.session.effectiveExtensionRoots, startupTimeoutMs: cfgMcpStartupTimeoutMs.get(this.session.settings) });
		this.assertIdle(); await this.session.refreshMCPTools(this.manager.getTools());
		this.loaded = fingerprint;
		return this.status();
	}
	async reconnect(name: unknown) {
		this.assertIdle();
		if (typeof name !== "string" || !this.manager?.getAllServerNames().includes(name)) return fail("Unknown MCP server in this conversation");
		await this.manager.reconnectServer(name, { manual: true });
		this.assertIdle(); await this.session.refreshMCPTools(this.manager.getTools());
		return this.status();
	}
}
