import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Dispatcher, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher, install } from "undici";
import type { OpenAIProxyConfig, OpenAIProxyState } from "./protocol.js";

/** Match origins, never URL substrings; custom endpoints and local callbacks stay untouched. */
export function isOpenAIOrigin(origin: string | URL | undefined): boolean {
	try {
		const url = new URL(String(origin));
		return ["https:", "wss:"].includes(url.protocol) && (!url.port || url.port === "443") &&
			["api.openai.com", "auth.openai.com", "chatgpt.com"].includes(url.hostname);
	} catch { return false; }
}

export function validateOpenAIProxy(value: unknown): OpenAIProxyConfig {
	const config = value as Partial<OpenAIProxyConfig> | null;
	if (!config || typeof config.enabled !== "boolean" || typeof config.url !== "string" || config.url.length > 2048) throw Error("Invalid proxy configuration");
	const raw = config.url.trim();
	if (!raw && !config.enabled) return { enabled: false, url: "" };
	let url: URL;
	try { url = new URL(raw); } catch { throw Error("Enter a valid HTTP or HTTPS proxy URL"); }
	if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
		throw Error("Use an HTTP or HTTPS proxy address without credentials, path, query or fragment");
	}
	return { enabled: config.enabled, url: url.origin };
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
		if (!this.active.enabled) return;
		const proxy = new ProxyAgent({ uri: this.active.url, allowH2: false });
		EventEmitter.prototype.on.call(proxy, "error", () => {});
		setGlobalDispatcher(new OpenAIProxyDispatcher(getGlobalDispatcher(), proxy));
		// Keep fetch, WebSocket and the dispatcher on one Undici version (also needed on Node 26).
		install();
	}
}
