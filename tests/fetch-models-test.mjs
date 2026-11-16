// fetch_models — custom-provider model-list auto-fetch test.
//
// The server probes a custom provider's OpenAI-compatible /models endpoint
// (server-side, so browser CORS doesn't apply) and returns the model ids.
// This test runs a LOCAL MOCK endpoint and verifies:
//   1. happy path: model ids come back, reqId is echoed
//   2. auth: Authorization: Bearer sent when authHeader=true; skipped when false
//   3. /v1 fallback: bare /models 404s → retried under /v1/models
//   4. error paths: invalid/unsupported baseUrl, empty list, non-JSON body
//   5. concurrent requests: each result matches its own reqId
//
// Usage: npm run build && node tests/fetch-models-test.mjs
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenIsolated, startIsolatedHarness } from "./lib/isolated-server.mjs";
import { testEnv } from "./lib/test-env.mjs";

let harness, c;
let MOCK_PORT;
const base = mkdtempSync(join(tmpdir(), "pi-web-fetchmodels-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(dataDir, "omp/agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

// ---------------------------------------------------------------------------
// Mock /models endpoint. Dispatch on pathname:
//   /models            → full list with metadata (records Authorization header)
//   /v1/models         → full list
//   /fallback/models   → 404 (forces the /v1 retry)
//   /fallback/v1/models→ small list
//   /google/models     → Google-format { models: [...] } (no `data` array)
//   /empty/models      → { data: [] }
//   /badjson/models    → not JSON
const authHeaders = [];
const mock = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname === "/models" || url.pathname === "/v1/models") {
		authHeaders.push({ path: url.pathname, auth: req.headers.authorization ?? null });
	}
	const send = (code, body) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(typeof body === "string" ? body : JSON.stringify(body));
	};
	if (url.pathname === "/fallback/models") return send(404, { error: "not found" });
	if (url.pathname === "/fallback/v1/models")
		return send(200, { data: [{ id: "fb-only" }] });
	if (url.pathname === "/google/models")
		return send(200, {
			models: [
				{
					name: "models/gemini-flash",
					displayName: "Gemini Flash",
					inputTokenLimit: 1048576,
					outputTokenLimit: 8192,
					supportedGenerationMethods: ["generateContent"],
				},
			],
		});
	if (url.pathname === "/precedence/models") return send(200, { data: [{
		id: "native-wins", context_length: 64000, context_window: 32768,
		display_name: "Alias name", metadata: { display_name: "Native name" },
		input: ["text"], modalities: ["image"], supports_vision: true,
		max_output_tokens: 5000,
	}] });
	if (url.pathname === "/empty/models") return send(200, { data: [] });
	if (url.pathname === "/badjson/models") return send(200, "definitely-not-json");
	if (url.pathname === "/models" || url.pathname === "/v1/models")
		return send(200, {
			data: [
				// vLLM-style extended metadata is parsed into the form rows.
				{ id: "mock-a", owned_by: "test", context_window: 32768, modalities: ["text", "image"] },
				{ id: "mock-b", max_model_len: 128000, supports_vision: true, supported_reasoning_levels: ["low", "medium", "high"] },
				{ id: "mock-a" }, // duplicate — must be deduped
				{ id: "mock-c", reasoning: true },
				{ id: "mock-d", display_name: "Mock D", max_output_tokens: 8192 },
			],
		});
	send(404, { error: "no route" });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
/** JSON comparison that ignores object key order. */
const sortKeysDeep = (o) => {
	if (Array.isArray(o)) return o.map(sortKeysDeep);
	if (o && typeof o === "object")
		return Object.fromEntries(
			Object.keys(o).sort().map((k) => [k, sortKeysDeep(o[k])]),
		);
	return o;
};
const canon = (o) => JSON.stringify(sortKeysDeep(o));
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		ws.on("message", (d) => this.received.push(JSON.parse(d.toString())));
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	async waitFor(type, timeout = 15000, pred) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (m.type !== type) continue;
				if (pred && !pred(m)) continue; // keep unmatched (may be wanted by another waiter)
				this.received.splice(i, 1);
				return m;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
}

async function connect() {
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	const client = new Client(ws);
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	return client;
}

try {
	MOCK_PORT = await listenIsolated(mock);
	writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ skills: { enabled: false }, cacheWarming: { enabled: false } }));
	const env = testEnv({ PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: workdir });
	for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^AWS_|^AZURE_|^OMP_/.test(key)) env[key] = undefined;
	harness = await startIsolatedHarness({ env });
	c = await connect();
	c.send({ type: "hello", clientId: "fetch-models-test" });
	await c.waitFor("ready", 30000);
	console.log("  · ready");

	// 1) happy path with auth (openai-completions → Authorization: Bearer)
	c.send({
		type: "fetch_models",
		reqId: 1,
		baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
		apiKey: "test-key",
		authHeader: true,
		api: "openai-completions",
	});
	const r1 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 1);
	assert.equal(r1.ok, true);
	assert.deepEqual(r1.models.map(model => model.id), ["mock-a", "mock-b", "mock-c", "mock-d"]);
	const [a, b, unknown, d] = r1.models;
	assert.equal(a.contextWindow, 32768, "top-level gateway context alias survives native discovery");
	assert.deepEqual(a.input, ["text", "image"]);
	assert.equal(b.contextWindow, 128000);
	assert.equal(b.reasoning, true, "native endpoint-declared reasoning ladder");
	assert.deepEqual(b.input, ["text", "image"]);
	assert.equal(d.name, "Mock D"); assert.equal(d.maxTokens, 8192);
	assert.equal(unknown.reasoning, false, "a bare boolean does not invent a native reasoning ladder");
	assert.equal(unknown.maxTokens, 32768, "OMP 18.20 discovery default, not the custom-model registration fallback");
	check("native defaults, sorted unique IDs and advertised metadata", true);
	check(
		"auth header sent (Bearer test-key)",
		authHeaders.some(
			(h) => h.path === "/models" && h.auth === "Bearer test-key",
		),
	);

	// 2) authHeader=false → no Authorization header
	c.send({
		type: "fetch_models",
		reqId: 2,
		baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
		apiKey: "test-key",
		authHeader: false,
		api: "openai-completions",
	});
	const r2 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 2);
	check(
		"authHeader=false: ok and no auth recorded on a NEW /models hit",
		r2.ok &&
			authHeaders
				.filter((h) => h.path === "/models")
				.some((h) => h.auth === null),
	);

	// 3) /v1 fallback: bare /models 404 → retried under /v1/models
	c.send({
		type: "fetch_models",
		reqId: 3,
		baseUrl: `http://127.0.0.1:${MOCK_PORT}/fallback`,
		api: "openai-completions",
	});
	const r3 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 3);
	check("/v1 fallback works", r3.ok && canon(r3.models.map(model => model.id)) === canon(["fb-only"]));

	// 4) error paths
	c.send({ type: "fetch_models", reqId: 4, baseUrl: "" });
	const r4 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 4);
	check("empty baseUrl → error", !r4.ok && /地址/.test(r4.error));

	c.send({ type: "fetch_models", reqId: 5, baseUrl: "ht!tp://nope" });
	const r5 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 5);
	check("invalid baseUrl → error", !r5.ok && r5.error.includes("无效"));

	c.send({ type: "fetch_models", reqId: 6, baseUrl: `ftp://127.0.0.1:${MOCK_PORT}` });
	const r6 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 6);
	check("non-http(s) baseUrl → error", !r6.ok && /http/i.test(r6.error));

	c.send({
		type: "fetch_models",
		reqId: 7,
		baseUrl: `http://127.0.0.1:${MOCK_PORT}/empty`,
	});
	const r7 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 7);
	check("empty model list → error", !r7.ok && r7.error.includes("未返回可用聊天模型"));

	c.send({
		type: "fetch_models",
		reqId: 8,
		baseUrl: `http://127.0.0.1:${MOCK_PORT}/badjson`,
	});
	const r8 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 8);
	check("non-JSON body → error", !r8.ok && !!r8.error && !r8.error.includes("definitely-not-json"));

	c.send({
		type: "fetch_models",
		reqId: 9,
		baseUrl: `http://127.0.0.1:${MOCK_PORT}/nonexistent`,
	});
	const r9 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 9);
	check("404 route → HTTP error surfaced", !r9.ok && r9.error.includes("404"));

	// 5) Google-format response ({ models: [...] }, no `data` array)
	c.send({
		type: "fetch_models",
		reqId: 10,
		baseUrl: `http://127.0.0.1:${MOCK_PORT}/google`,
		api: "google-generative-ai",
	});
	const r10 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 10);
	assert.equal(r10.ok, true);
	assert.equal(r10.models.length, 1);
	assert.equal(r10.models[0].id, "gemini-flash");
	assert.equal(r10.models[0].name, "Gemini Flash");
	assert.equal(r10.models[0].contextWindow, 1048576);
	assert.equal(r10.models[0].maxTokens, 8192);
	check("google envelope normalized with native limits", true);

	// 6) concurrent requests: reqIds stay matched
	c.send({
		type: "fetch_models",
		reqId: 11,
		baseUrl: `http://127.0.0.1:${MOCK_PORT}/fallback`,
	});
	c.send({
		type: "fetch_models",
		reqId: 12,
		baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
		apiKey: "k2",
		authHeader: true,
	});
	const r11 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 11);
	const r12 = await c.waitFor("fetch_models_result", 10000, (m) => m.reqId === 12);
	check(
		"concurrent reqIds matched",
		r11.ok && canon(r11.models.map(model => model.id)) === canon(["fb-only"]) &&
			r12.ok &&
			canon(r12.models).includes('"id":"mock-a"') &&
			canon(r12.models).includes('"contextWindow":32768'),
	);

	c.send({ type: "fetch_models", reqId: 13, baseUrl: `http://127.0.0.1:${MOCK_PORT}/precedence` });
	const precedence = await c.waitFor("fetch_models_result", 10000, message => message.reqId === 13);
	assert.equal(precedence.ok, true);
	assert.equal(precedence.models[0].name, "Native name");
	assert.equal(precedence.models[0].contextWindow, 64000);
	assert.equal(precedence.models[0].maxTokens, 5000);
	assert.deepEqual(precedence.models[0].input, ["text"]);
	check("native metadata takes precedence over gateway aliases", true);
	assert(!c.received.some(event => event.type === "notice" && event.level === "error"));
	console.log(`\n${passed} checks passed`);
} catch (err) {
	// Debug aid: dump what actually arrived before the failure.
	if (typeof c !== "undefined") {
		console.log(
			"[debug] received so far:",
			c.received.map((m) => m.type).join(","),
		);
	}
	throw err;
} finally {
	c?.ws.terminate();
	await harness?.stop();
	mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
	rmSync(base, { recursive: true, force: true });
}
