/** Bun-only. Native HTTP(S)_PROXY reaches fetch, HTTP/2 and both WebSocket implementations.
 * A private loopback relay keeps the application's upstream proxy domain-scoped.
 * TLS stays end-to-end; neither model payloads nor credentials are inspected. */
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { shouldBypassProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import { isOpenAIOrigin, validateOpenAIProxy } from "../openai-proxy-policy.js";
import type { OpenAIProxyConfig } from "../protocol.js";

export async function createOmpProxy(config: OpenAIProxyConfig, environment: NodeJS.ProcessEnv = { ...process.env }, connectProtocol: "http:" | "https:" = "https:") {
	const active = validateOpenAIProxy(config);
	if (!active.enabled) throw Error("Proxy disabled");
	const authorization = Buffer.from(`Basic ${Buffer.from(`omp:${randomBytes(32).toString("hex")}`).toString("base64")}`);
	const sockets = new Set<Duplex>();
	const requests = new Set<ReturnType<typeof httpRequest>>();
	const keep = <T extends Duplex>(socket: T): T => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); return socket; };
	const authorized = (request: IncomingMessage) => {
		const value = Buffer.from(request.headers["proxy-authorization"] ?? "");
		return value.length === authorization.length && timingSafeEqual(value, authorization);
	};
	const upstream = (target: URL): URL | undefined => {
		const raw = isOpenAIOrigin(target) ? active.url : shouldBypassProxy(target) ? undefined
			: (target.protocol === "https:" ? environment.HTTPS_PROXY || environment.https_proxy : environment.HTTP_PROXY || environment.http_proxy) || environment.ALL_PROXY || environment.all_proxy;
		if (!raw) return;
		const url = new URL(raw);
		if (!["http:", "https:"].includes(url.protocol)) throw Error("Unsupported upstream proxy");
		return url;
	};
	const proxyHeaders = (url: URL) => url.username || url.password
		? { "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}` } : {};
	const proxyAddress = (url: URL) => {
		// http.request turns URL credentials into origin Authorization. Proxy
		// credentials belong only in Proxy-Authorization, including on CONNECT.
		const address = new URL(url);
		address.username = ""; address.password = "";
		return address;
	};
	const track = (request: ReturnType<typeof httpRequest>) => {
		requests.add(request); request.once("close", () => requests.delete(request));
		request.on("socket", socket => keep(socket)); return request;
	};
	const server = createServer((incoming, outgoing) => {
		if (!authorized(incoming)) { outgoing.writeHead(407); outgoing.end(); return; }
		try {
			const target = new URL(incoming.url ?? "");
			if (target.protocol !== "http:" || target.username || target.password) throw Error("Invalid proxy target");
			const proxy = upstream(target);
			const headers: import("node:http").OutgoingHttpHeaders = { ...incoming.headers, host: target.host };
			delete headers["proxy-authorization"]; delete headers["proxy-connection"];
			const request = track((proxy?.protocol === "https:" ? httpsRequest : httpRequest)(proxy ? proxyAddress(proxy) : target, {
				method: incoming.method, path: proxy ? target.href : target.pathname + target.search,
				headers: { ...headers, ...(proxy ? proxyHeaders(proxy) : {}) }, agent: false,
			}, response => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); }));
			request.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
			incoming.on("aborted", () => request.destroy()); outgoing.once("close", () => request.destroy());
			incoming.pipe(request);
		} catch { outgoing.writeHead(502); outgoing.end(); }
	});
	server.on("connection", socket => { keep(socket); socket.on("error", () => {}); });
	server.on("connect", (incoming, client, head) => {
		if (!authorized(incoming)) { client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return; }
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let pending: ReturnType<typeof httpRequest> | undefined;
		let remote: Socket | undefined;
		let connected = false;
		const fail = () => {
			clearTimeout(timeout); pending?.destroy(); remote?.destroy();
			if (connected) client.destroy();
			else if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		};
		const tunnel = (socket: Socket, remainder = Buffer.alloc(0)) => {
			if (client.destroyed) { socket.destroy(); return; }
			clearTimeout(timeout); connected = true; remote = keep(socket);
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (remainder.length) client.write(remainder);
			if (head.length) socket.write(head);
			socket.on("error", () => client.destroy());
			socket.once("close", () => client.destroy());
			client.pipe(socket); socket.pipe(client);
		};
		client.once("close", () => { clearTimeout(timeout); pending?.destroy(); remote?.destroy(); });
		try {
			const authority = incoming.url ?? "";
			if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):[0-9]{1,5}$/.test(authority)) throw Error("Invalid CONNECT authority");
			const target = new URL(`${connectProtocol}//${authority}`);
			const proxy = upstream(target);
			timeout = setTimeout(fail, 15_000); timeout.unref();
			if (!proxy) {
				remote = keep(connect({ host: target.hostname.replace(/^\[|\]$/g, ""), port: Number(target.port || (target.protocol === "http:" ? 80 : 443)) }));
				remote.once("connect", () => tunnel(remote!)); remote.once("error", fail);
			} else {
				pending = track((proxy.protocol === "https:" ? httpsRequest : httpRequest)(proxyAddress(proxy), {
					method: "CONNECT", path: authority, headers: { Host: authority, ...proxyHeaders(proxy) }, agent: false,
				}));
				pending.once("connect", (response, socket, remainder) => {
					if (response.statusCode !== 200) { socket.destroy(); fail(); return; }
					tunnel(socket, remainder);
				});
				pending.once("error", () => { if (!connected) fail(); else client.destroy(); });
				pending.end();
			}
		} catch { fail(); }
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
	});
	server.unref();
	const address = server.address();
	if (!address || typeof address === "string") throw Error("Proxy listener unavailable");
	const credentials = Buffer.from(authorization.toString().slice(6), "base64").toString();
	let closing: Promise<void> | undefined;
	return {
		url: `http://${credentials}@127.0.0.1:${address.port}`,
		close: () => closing ??= new Promise<void>(resolve => {
			for (const request of requests) request.destroy();
			for (const socket of sockets) socket.destroy();
			server.close(() => resolve());
		}),
	};
}

export async function installOmpProxy(config: OpenAIProxyConfig) {
	const environment = { ...process.env };
	const https = await createOmpProxy(config, environment, "https:");
	try {
		const http = await createOmpProxy(config, environment, "http:");
		// Separate native protocol variables preserve the original HTTP vs HTTPS
		// route even for CONNECT-based ws:// handshakes on arbitrary ports.
		process.env.HTTPS_PROXY = process.env.https_proxy = https.url;
		process.env.HTTP_PROXY = process.env.http_proxy = http.url;
		return async () => { await Promise.all([https.close(), http.close()]); };
	} catch (error) { await https.close(); throw error; }
}
