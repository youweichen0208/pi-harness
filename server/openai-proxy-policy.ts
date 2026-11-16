import type { OpenAIProxyConfig } from "./protocol.js";

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

