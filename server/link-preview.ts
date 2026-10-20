import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Express } from "express";
import type { LinkPreview } from "./protocol.js";
import { imageBytes } from "./note-assets.js";
const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",3]] as const) blocked.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList(), blockedV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [["2001::",23], ["2001:db8::",32], ["2002::",16], ["3fff::",20]] as const) blockedV6.addSubnet(network, prefix, "ipv6");
export function publicAddress(address: string): boolean {
	if (isIP(address) === 4) return !blocked.check(address, "ipv4");
	// Global unicast only; exclude transition/documentation ranges.
	return isIP(address) === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}
async function publicFetch(input: string, max: number, signal: AbortSignal, redirects = 0): Promise<{ bytes: Buffer; url: string; type: string }> {
	const url = new URL(input);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || redirects > 3 || (url.port && !["80", "443"].includes(url.port))) throw new Error("Unsupported URL");
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.throwIfAborted(); signal.addEventListener("abort", abort, { once: true });
		lookup(hostname, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
	if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("Public URLs only");
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		// Pin the checked DNS result to this connection; redirects repeat validation.
		const chosen = addresses[0];
		const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
			signal, agent: false, family: chosen.family,
			lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family),
			headers: { Accept: "text/html,image/*", "Accept-Encoding": "identity", "User-Agent": "pi-harness-link-preview" },
		}, response => {
			if ([301,302,303,307,308].includes(response.statusCode ?? 0) && response.headers.location) {
				response.destroy(); publicFetch(new URL(response.headers.location, url).href, max, signal, redirects + 1).then(resolve, reject); return;
			}
			if (response.statusCode !== 200 || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) { response.destroy(); reject(new Error("Preview unavailable")); return; }
			let size = 0; const chunks: Buffer[] = [];
			response.on("data", chunk => { size += chunk.length; if (size > max) response.destroy(new Error("Response too large")); else chunks.push(chunk); });
			response.on("error", reject);
			response.on("end", () => resolve({ bytes: Buffer.concat(chunks), url: url.href, type: response.headers["content-type"] ?? "" }));
		});
		req.on("error", reject); req.end();
	});
}
function decode(value: string) {
	return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, key: string) => {
		if (key.startsWith("#")) { const number = key[1].toLowerCase() === "x" ? parseInt(key.slice(2),16) : parseInt(key.slice(1),10); return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ""; }
		return ({ amp:"&",lt:"<",gt:">",quot:'"',apos:"'" } as Record<string,string>)[key.toLowerCase()] ?? whole;
	}).replace(/\s+/g, " ").trim();
}
export function previewMetadata(html: string, url: string): LinkPreview {
	const meta = new Map<string, string>();
	for (const tag of html.matchAll(/<meta\s+[^>]*>/gi)) {
		const attrs = new Map([...tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), decode(m[2] ?? m[3])]));
		const name = attrs.get("property") ?? attrs.get("name"); if (name && attrs.has("content")) meta.set(name.toLowerCase(), attrs.get("content")!);
	}
	return { url, title: (meta.get("og:title") || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || new URL(url).hostname).slice(0,500), description: (meta.get("og:description") || meta.get("description") || "").slice(0,2000), imageUrl: meta.get("og:image") };
}
export function installLinkPreview(app: Express, allowed: (req: IncomingMessage) => boolean) {
	let active = 0;
	app.post("/api/link-preview", async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowed(req) || !req.is("application/json")) { res.sendStatus(403); return; }
		if (typeof req.body?.url !== "string" || req.body.url.length > 4096) { res.sendStatus(400); return; }
		if (active >= 4) { res.sendStatus(429); return; }
		active++;
		try {
			const signal = AbortSignal.timeout(8000), page = await publicFetch(req.body.url, 2 * 1024 * 1024, signal);
			if (!/^text\/html\b/i.test(page.type)) throw new Error("HTML required");
			const result = previewMetadata(page.bytes.toString("utf8"), page.url);
			if (result.imageUrl) try { const cover = await publicFetch(new URL(result.imageUrl, page.url).href, 5 * 1024 * 1024, signal); result.imageData = imageBytes(cover.bytes.toString("base64")).bytes.toString("base64"); } catch { /* A cover is optional. */ }
			delete result.imageUrl; res.json(result);
		} catch { res.status(422).json({ error: "Preview unavailable; enter card details manually" }); }
		finally { active--; }
	});
}
