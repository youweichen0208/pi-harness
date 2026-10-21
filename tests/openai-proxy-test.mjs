/** Local CONNECT/TLS/WebSocket fixtures; no real credentials or external API calls. */
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { OpenAIProxySettings } from "../dist/server/openai-proxy.js";
import { portUp } from "./lib/port-utils.mjs";
import { testEnv } from "./lib/test-env.mjs";

if (process.argv[2] === "--network-child") {
	const settings = new OpenAIProxySettings(process.argv[3]);
	settings.install();
	assert.equal(await (await fetch("https://api.openai.com/v1/responses")).text(), "fixture stream");
	const { openaiCodexOAuth } = await import("../node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js");
	const credential = await openaiCodexOAuth.refresh({ type: "oauth", access: "old", refresh: "fixture", expires: 0 }, new AbortController().signal);
	assert.equal(credential.accountId, "fixture-account");
	const socket = new WebSocket("wss://chatgpt.com/backend-api/codex/responses");
	await new Promise((resolve, reject) => {
		socket.addEventListener("message", event => { assert.equal(event.data, "fixture websocket"); socket.close(); resolve(); }, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	assert.equal(await (await fetch("http://127.0.0.1:9363")).text(), "direct");
	console.log("PASS proxy HTTP, SDK OAuth refresh, WebSocket and loopback bypass");
} else {
	for (const port of [9360, 9361, 9362, 9363]) assert.equal(await portUp(port), false, `port ${port} busy`);
	const directory = mkdtempSync(join(tmpdir(), "openai-proxy-"));
	const data = join(directory, "data"), agent = join(directory, "agent");
	mkdirSync(agent); mkdirSync(data);
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:9363/v1", apiKey: "fixture", models: [{ id: "fixture", name: "Fixture", contextWindow: 32000, maxTokens: 4096 }] } } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
	writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture" } }));
	const cert = resolve("tests/fixtures/openai-proxy/cert.pem"), key = resolve("tests/fixtures/openai-proxy/key.pem");
	const hits = [], tunnels = [], sockets = new Set();
	const tls = httpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (req, res) => {
		hits.push(req.url);
		for await (const _ of req) {}
		if (req.url.includes("token")) {
			const jwt = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ access_token: jwt, refresh_token: "fixture", expires_in: 3600 }));
		} else res.end("fixture stream");
	});
	const wss = new WebSocketServer({ server: tls });
	wss.on("connection", socket => socket.send("fixture websocket"));
	const proxy = httpServer();
	proxy.on("connect", (req, socket, head) => {
		tunnels.push(req.url);
		assert(["api.openai.com:443", "auth.openai.com:443", "chatgpt.com:443"].includes(req.url));
		const upstream = connect(9360, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
		for (const connection of [socket, upstream]) { sockets.add(connection); connection.on("close", () => sockets.delete(connection)); connection.on("error", () => { socket.destroy(); upstream.destroy(); }); }
	});
	const direct = httpServer((_req, res) => res.end("direct"));
	let server, browser, log = "";
	const env = { ...testEnv(), PORT: "9362", PI_WEB_HOST: "127.0.0.1", PI_WEB_TOKEN: "fixture-token", PI_WEB_CWD: directory, PI_WEB_DATA_DIR: data, PI_CODING_AGENT_DIR: agent };
	const start = async () => {
		server = spawn(process.execPath, ["dist/server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
		server.stdout.on("data", b => { log += b; }); server.stderr.on("data", b => { log += b; });
		for (let i = 0; i < 150 && !await portUp(9362); i++) { assert.equal(server.exitCode, null, log); await new Promise(r => setTimeout(r, 100)); }
		assert(await portUp(9362), log);
	};
	const stop = async () => { if (server && server.exitCode === null && server.signalCode === null) { const exited = once(server, "exit"); server.kill(); await exited; } };
	const request = (body, headers = {}) => fetch("http://127.0.0.1:9362/api/openai-proxy", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-token", ...headers }, body: JSON.stringify(body) });
	try {
		for (const [instance, port] of [[tls, 9360], [proxy, 9361], [direct, 9363]]) await new Promise(r => instance.listen(port, "127.0.0.1", r));
		await start();
		assert.equal((await request({ action: "get" }, { authorization: "" })).status, 401);
		assert.equal((await request({ action: "get" }, { origin: "https://evil.test" })).status, 403);
		let state = await (await request({ action: "get" })).json();
		assert.equal(state.enabled, false); assert.equal(state.url, "");
		assert.equal((await request({ action: "save", version: state.version, config: { enabled: true, url: "socks5://localhost:10808" } })).status, 400);
		const oldVersion = state.version;
		state = await (await request({ action: "save", version: state.version, config: { enabled: true, url: "http://127.0.0.1:9361" } })).json();
		assert.equal(state.restartRequired, true);
		assert.equal((await request({ action: "save", version: oldVersion, config: { enabled: false, url: "" } })).status, 400);
		await stop(); await start();
		state = await (await request({ action: "get" })).json(); assert.equal(state.restartRequired, false);
		const child = spawn(process.execPath, ["tests/openai-proxy-test.mjs", "--network-child", data], { env: { ...testEnv(), NODE_EXTRA_CA_CERTS: cert }, stdio: ["ignore", "pipe", "pipe"] });
		let output = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
		const timer = setTimeout(() => child.kill(), 20000);
		const [code] = await once(child, "exit"); clearTimeout(timer); assert.equal(code, 0, output);
		assert(tunnels.includes("api.openai.com:443")); assert(tunnels.includes("auth.openai.com:443")); assert(tunnels.includes("chatgpt.com:443"));
		assert(hits.includes("/oauth/token"));
		if (process.argv.includes("--browser")) {
			const { chromium } = await import("playwright-core"); const { CHROME_PATH } = await import("./lib/chrome.mjs");
			browser = await chromium.launch({ executablePath: CHROME_PATH || chromium.executablePath() });
			const page = await browser.newPage();
			await page.goto("http://127.0.0.1:9362/?token=fixture-token");
			await page.locator(".conn-dot.ok").first().waitFor({ state: "attached" });
			await page.locator(".chip-model:visible").first().click();
			await page.getByRole("button", { name: "管理模型（新增 / 修改）", exact: true }).click();
			const panel = page.locator(".openai-proxy-settings");
			await panel.waitFor({ timeout: 5000 });
			await panel.locator("summary").click();
			await panel.locator('input[type="url"]').fill("http://127.0.0.1:9364");
			await panel.getByRole("button", { name: "保存", exact: true }).click();
			await panel.getByRole("status").filter({ hasText: "重启" }).waitFor();
			assert.equal((await (await request({ action: "get" })).json()).url, "http://127.0.0.1:9364");
		}
		state = await (await request({ action: "get" })).json();
		await request({ action: "save", version: state.version, config: { enabled: false, url: "" } });
		await stop(); await start();
		assert.equal((await (await request({ action: "get" })).json()).enabled, false);
		console.log("PASS OpenAI proxy: default off, validation/auth/origin, persistence/restart, CONNECT, OAuth and WebSocket");
	} finally {
		await browser?.close(); await stop();
		for (const socket of sockets) socket.destroy();
		for (const socket of wss.clients) socket.terminate();
		wss.close();
		for (const instance of [proxy, tls, direct]) { instance.closeAllConnections(); await new Promise(r => instance.close(r)); }
		rmSync(directory, { recursive: true, force: true });
	}
}
