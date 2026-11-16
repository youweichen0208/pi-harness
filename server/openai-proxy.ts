import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Dispatcher, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher, install } from "undici";
import type { OpenAIProxyConfig, OpenAIProxyState } from "./protocol.js";

import { isOpenAIOrigin, validateOpenAIProxy } from "./openai-proxy-policy.js";
export { isOpenAIOrigin, validateOpenAIProxy } from "./openai-proxy-policy.js";

const activeConfigurations = new Map<string, OpenAIProxyConfig>();
/** Freeze settings once per host lifetime, including workers created after a save. */
export function activeOpenAIProxy(dataDir: string): OpenAIProxyConfig {
	const key = resolve(dataDir);
	let config = activeConfigurations.get(key);
	if (!config) {
		const state = new OpenAIProxySettings(dataDir).state();
		config = { enabled: state.enabled, url: state.url };
		activeConfigurations.set(key, config);
	}
	return { ...config };
}

export class OpenAIProxyDispatcher extends Dispatcher {
	constructor(private readonly fallback: Dispatcher, private readonly proxy: Dispatcher) { super(); }
	override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
		return (isOpenAIOrigin(options.origin) ? this.proxy : this.fallback).dispatch(options, handler);
	}
}

/** Machine-local setting shared by tabs. A restart also retires SDK-cached WebSockets. */
export class OpenAIProxySettings {
	private readonly file: string;
	private readonly active: OpenAIProxyConfig;
	constructor(dataDir: string) {
		this.file = join(dataDir, "openai-proxy.json");
		this.active = this.read().config;
	}
	private read(): { config: OpenAIProxyConfig; version: string } {
		const raw = existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
		return { config: raw ? validateOpenAIProxy(JSON.parse(raw)) : { enabled: false, url: "" }, version: createHash("sha256").update(raw).digest("hex") };
	}
	state(): OpenAIProxyState {
		const { config, version } = this.read();
		return { ...config, version, restartRequired: JSON.stringify(config) !== JSON.stringify(this.active) };
	}
	save(value: unknown, version: unknown): OpenAIProxyState {
		const config = validateOpenAIProxy(value);
		if (version !== this.read().version) throw Error("Proxy settings changed; reopen this panel before saving");
		mkdirSync(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
		renameSync(temporary, this.file);
		return this.state();
	}
	install(): void {
		activeConfigurations.set(resolve(dirname(this.file)), { ...this.active });
		if (!this.active.enabled) return;
		const proxy = new ProxyAgent({ uri: this.active.url, allowH2: false });
		EventEmitter.prototype.on.call(proxy, "error", () => {});
		setGlobalDispatcher(new OpenAIProxyDispatcher(getGlobalDispatcher(), proxy));
		// Keep fetch, WebSocket and the dispatcher on one Undici version (also needed on Node 26).
		install();
	}
}
