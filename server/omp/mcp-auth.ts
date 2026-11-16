/** Bun-only presentation bridge for OMP's shared MCP OAuth engine. */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { findMcpServerForAuth, matchingManagerServerConfig, reauthorizeMcpServer, reconnectMcpManagerServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import { lookupMcpOAuthCredential, mcpOAuthCredentialIdsForServerUrl, removeManagedMcpOAuthCredentials } from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { UiOmpMcpAuth } from "../protocol.js";

type Job = { view: UiOmpMcpAuth; abort: AbortController; done?: Promise<void>; input?: (value: string) => void };
class DefinitionChanged extends Error {}
// Native persistence omits undefined fields; compare the same JSON value shape.
const sameConfig = (a: unknown, b: unknown) => isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
export class OmpMcpAuth {
	private job?: Job;
	constructor(private session: AgentSession, private manager: MCPManager | undefined, private stopping: () => boolean) {}
	get active() { return this.job?.view.status === "pending"; }
	get state() { return this.job ? { ...this.job.view } : undefined; }
	private get storage() { return this.session.modelRegistry.authStorage; }
	serverState(name: string) {
		const config = this.manager?.getServerConfig(name);
		return { oauthAvailable: !!config && (config.type === "http" || config.type === "sse"), authenticated: !!config && !!lookupMcpOAuthCredential(this.storage, config) };
	}
	private assertIdle() {
		if (this.stopping() || this.session.isDisposed || this.session.isStreaming || this.active) throw Error("MCP OAuth operation unavailable");
	}
	private async projectPolicyOnDisk() {
		const settings = await Settings.loadReadOnly({ cwd: this.session.settings.getCwd(), agentDir: this.session.settings.getAgentDir(), configFiles: [...this.session.settings.getConfigFiles()] });
		return cfgMcpEnableProjectConfig.get(settings);
	}
	private async find(name: unknown) {
		if (typeof name !== "string" || !this.manager?.getAllServerNames().includes(name)) throw Error("Unknown MCP server");
		const found = await findMcpServerForAuth(name, this.session.settings.getCwd(), this.manager, { enableProjectConfig: cfgMcpEnableProjectConfig.get(this.session.settings) });
		if (!found || !matchingManagerServerConfig(this.manager, name, found.config)) throw Error("MCP definition changed; reload first");
		return { name, found, projectPolicy: await this.projectPolicyOnDisk() };
	}
	async login(name: unknown) {
		this.assertIdle();
		const selected = await this.find(name); this.assertIdle();
		const job: Job = { view: { id: randomUUID(), name: selected.name, status: "pending" }, abort: new AbortController() };
		this.job = job;
		job.done = this.run(job, selected);
	}
	private async checkSelection(selected: Awaited<ReturnType<OmpMcpAuth["find"]>>, outcome: Awaited<ReturnType<typeof reauthorizeMcpServer>>) {
		const { name, found } = selected;
		try {
			// Read native discovery again, including deny/allow lists, scope shadowing
			// and extension sources. This is a reconnect guard, not persistence CAS.
			clearCache();
			if (selected.projectPolicy !== await this.projectPolicyOnDisk()) throw new DefinitionChanged();
			const options = { enableProjectConfig: cfgMcpEnableProjectConfig.get(this.session.settings) };
			const current = await findMcpServerForAuth(name, this.session.settings.getCwd(), this.manager, options);
			if (!current || current.filePath !== found.filePath || current.scope !== found.scope
				|| current.discovered !== (outcome.persisted ? false : found.discovered) || !sameConfig(current.config, outcome.config)) throw new DefinitionChanged();
			const catalog = await loadAllMCPConfigs(this.session.settings.getCwd(), { ...options, filterExa: true,
				filterBrowser: this.session.getEvalPreludes().some(item => item.name === "browser"), extensionRoots: this.session.effectiveExtensionRoots });
			const effective = catalog.configs[name];
			if (!effective || !matchingManagerServerConfig(this.manager, name, effective)) throw new DefinitionChanged();
			if (current.discovered) {
				// A manager fallback alone cannot prove that a discovered source still
				// exists or still declares the same connection options.
				const source = catalog.sources[name], previous = this.manager?.getSource(name);
				if (!source || !previous || source.path !== previous.path || source.provider !== previous.provider || source.level !== previous.level
					|| !sameConfig(effective, this.manager?.getServerConfig(name))) throw new DefinitionChanged();
			}
		} catch { throw new DefinitionChanged(); }
	}
	private async run(job: Job, selected: Awaited<ReturnType<OmpMcpAuth["find"]>>) {
		const { name, found } = selected;
		try {
			const outcome = await reauthorizeMcpServer(name, found, {
				authStorage: this.storage, mcpManager: this.manager, cwd: this.session.settings.getCwd(), signal: job.abort.signal, flowOwner: this,
				onAuth: info => {
					if (job.abort.signal.aborted) throw Error("Cancelled");
					const url = new URL(info.url);
					if (url.username || url.password || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw Error("Unsupported authorization URL");
					job.view.url = url.href;
				},
				onManualCodeInput: () => new Promise<string>(resolve => { job.input = resolve; job.view.inputRequired = true; }),
				releaseManualInput: () => { job.input?.(""); job.input = undefined; delete job.view.inputRequired; },
			});
			// Credentials may have been saved before cancellation. Never claim they
			// were rolled back, and never reconnect a stopped conversation.
			if (job.abort.signal.aborted || this.stopping() || this.session.isDisposed) return;
			await this.checkSelection(selected, outcome);
			if (job.abort.signal.aborted || this.stopping() || this.session.isDisposed) return;
			await reconnectMcpManagerServer(this.manager, name, found.config);
			if (job.abort.signal.aborted || this.stopping() || this.session.isDisposed) return;
			await this.session.refreshMCPTools(this.manager!.getTools());
			job.view.status = "complete";
		} catch (error) { job.view.status = job.abort.signal.aborted ? "cancelled" : error instanceof DefinitionChanged ? "configuration_changed" : "failed"; }
		finally {
			if (job.view.status === "pending") job.view.status = "cancelled";
			delete job.view.url; delete job.view.inputRequired; job.input?.(""); job.input = undefined;
		}
	}
	input(id: unknown, value: unknown) {
		const job = this.job;
		if (!job || job.view.id !== id || !this.active || !job.input || job.abort.signal.aborted || typeof value !== "string" || !value.trim() || value.length > 16384) throw Error("MCP OAuth input expired");
		const resolve = job.input; job.input = undefined; delete job.view.inputRequired; resolve(value.trim());
	}
	async cancel(id: unknown) {
		if (!this.job || this.job.view.id !== id) throw Error("MCP OAuth operation expired");
		this.stop(); await this.job.done;
	}
	stop() { if (this.active) this.job!.abort.abort(); }
	async logout(name: unknown) {
		this.assertIdle();
		const selected = await this.find(name); this.assertIdle();
		const config = selected.found.config;
		const url = config.type === "http" || config.type === "sse" ? config.url : undefined;
		const removed = await removeManagedMcpOAuthCredentials(this.storage, [config.auth?.credentialId, ...mcpOAuthCredentialIdsForServerUrl(url)]);
		if (!removed) throw Error("No OMP-managed OAuth credential to clear");
		await this.manager!.disconnectServer(selected.name);
		this.job = { view: { id: randomUUID(), name: selected.name, status: "signed_out" }, abort: new AbortController() };
		if (!this.stopping() && !this.session.isDisposed) await this.session.refreshMCPTools(this.manager!.getTools());
	}
}
