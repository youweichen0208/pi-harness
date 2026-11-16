import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { testEnv } from "./lib/test-env.mjs";
const require = createRequire(import.meta.url);
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN"]) delete process.env[key];
async function saveAuth(agentDir, document, hold = false) {
	let closing = false;
	const child = spawn(join(dirname(require.resolve("bun/package.json")), "bin/bun.exe"), ["--eval", `
		import { AuthStorage } from "@oh-my-pi/pi-coding-agent";
		const { document, hold } = JSON.parse(await Bun.stdin.text());
		const auth = await AuthStorage.create(process.env.PI_CODING_AGENT_DIR + "/agent.db");
		await auth.credentials.reload();
		for (const provider of Object.keys(auth.credentials.all())) await auth.credentials.remove(provider);
		for (const [provider, value] of Object.entries(document)) await auth.credentials.set(provider, value);
		if (hold) {
			const timer = setInterval(() => {}, 1000);
			process.once("SIGTERM", () => { clearInterval(timer); auth.close(); process.exit(0); });
			process.stdout.write("ready\\n");
		} else auth.close();
	`], { env: { ...testEnv(), PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "ignore"] });
	const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 || closing ? resolve() : reject(new Error("Native auth fixture failed"))); });
	const ready = hold ? new Promise((resolve, reject) => { child.stdout.once("data", resolve); done.then(() => reject(new Error("Auth fixture exited before ready")), reject); }) : undefined;
	child.stdin.end(JSON.stringify({ document, hold }));
	if (hold) { await ready; return { close: async () => { closing = true; child.kill(); await done; } }; }
	await done;
}
import { resolveOmpModel } from "../dev/context-eval/omp-model.mjs";
import { loadConfig, reportConfig } from "../dev/context-eval/config.mjs";

async function nativeFixture(t) {
	const root = await mkdtemp(join(tmpdir(), "context-omp-model-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const files = {
		"config.yml": { modelRoles: { default: "eval_native_one/default-model" } },
		"models.yml": { providers: {
			eval_native_one: {
				api: "anthropic-messages", auth: "oauth", baseUrl: "https://intranet.example.invalid/compatible/anthropic",
				headers: { "X-Gateway-Key": "fixture-gateway-secret" },
				models: [{ id: "default-model", name: "Default", input: ["text"], contextWindow: 100000, maxTokens: 8192, compat: { disableStrictTools: true } }],
			},
			eval_native_two: {
				api: "openai-completions", auth: "oauth", baseUrl: "http://10.20.30.40/v1",
				models: [{ id: "override-model", name: "Override", input: ["text"], contextWindow: 64000, maxTokens: 2048 }],
			},
		} },
		"auth.json": {
			eval_native_one: { type: "api_key", key: "fixture-default-secret" },
			eval_native_two: { type: "api_key", key: "fixture-override-secret" },
		},
	};
	const original = new Map();
	const capture = async () => {
		original.clear();
		for (const name of await readdir(agentDir)) original.set(name, await readFile(join(agentDir, name)));
	};
	for (const [name, document] of Object.entries(files)) {
		const text = `${JSON.stringify(document, null, "\t")}\n`;
		if (name === "auth.json") {
			await saveAuth(agentDir, document);
			original.set("agent.db", await readFile(join(agentDir, "agent.db")));
		} else {
			await writeFile(join(agentDir, name), text, { mode: 0o600 });
			original.set(name, text);
		}
	}
	await capture();
	return { root, agentDir, files, async replace(name, document) {
		const text = `${JSON.stringify(document, null, "\t")}\n`;
		if (name === "auth.json") {
			await saveAuth(agentDir, document);
			original.set("agent.db", await readFile(join(agentDir, "agent.db")));
		} else {
			await writeFile(join(agentDir, name), text, { mode: 0o600 });
			original.set(name, text);
		}
		await capture();
	}, async assertUnchanged() {
		for (const [name, text] of original) assert.deepEqual(await readFile(join(agentDir, name), typeof text === "string" ? "utf8" : undefined), text, `${name} must remain unchanged`);
		assert.deepEqual((await readdir(agentDir)).sort(), [...original.keys()].sort(), "native config reads must not create source files");
	} };
}

test("OMP default model resolves native credentials and headers without editing original files", async t => {
	const fixture = await nativeFixture(t);
	await fixture.assertUnchanged();
	const model = await resolveOmpModel({ fromOmp: true, agentDir: "agent" }, fixture.root);
	assert.equal(model.fromOmp, true);
	assert.equal(model.provider, "eval_native_one");
	assert.equal(model.id, "default-model");
	assert.equal(model.api, "anthropic-messages");
	assert.equal(model.baseUrl, "https://intranet.example.invalid/compatible/anthropic");
	assert.equal(model.contextWindow, 100000);
	assert.equal(model.maxTokens, 8192);
	assert.equal(model.apiKey, "fixture-default-secret");
	assert.equal(model.headers["X-Gateway-Key"], "fixture-gateway-secret");
	assert.equal(model.compat.disableStrictTools, true);
	await fixture.assertUnchanged();
});

test("native credentials committed in a live WAL are included without changing source files", async t => {
	const fixture = await nativeFixture(t);
	const held = await saveAuth(fixture.agentDir, { eval_native_one: { type: "api_key", key: "fixture-live-wal-key" } }, true);
	try {
		const names = (await readdir(fixture.agentDir)).sort();
		assert.ok(names.includes("agent.db-wal"));
		const before = await Promise.all(names.map(name => readFile(join(fixture.agentDir, name))));
		assert.ok(before[names.indexOf("agent.db-wal")].length > 0);
		const model = await resolveOmpModel({ fromOmp: true, agentDir: "agent" }, fixture.root);
		assert.equal(model.apiKey, "fixture-live-wal-key");
		assert.deepEqual((await readdir(fixture.agentDir)).sort(), names);
		for (const [i, name] of names.entries()) assert.deepEqual(await readFile(join(fixture.agentDir, name)), before[i], name);
	} finally { await held.close(); }
});

test("explicit OMP provider/model and token limits override saved defaults", async t => {
	const fixture = await nativeFixture(t);
	const model = await resolveOmpModel({ fromOmp: true, agentDir: fixture.agentDir, provider: "eval_native_two", id: "override-model", contextWindow: 32000, maxTokens: 1000 }, fixture.root);
	assert.equal(model.provider, "eval_native_two");
	assert.equal(model.id, "override-model");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, "http://10.20.30.40/v1");
	assert.equal(model.contextWindow, 32000);
	assert.equal(model.maxTokens, 1000);
	assert.equal(model.apiKey, "fixture-override-secret");
	assert.ok(!JSON.stringify(model).includes("fixture-default-secret"));
	assert.ok(!JSON.stringify(model).includes("fixture-gateway-secret"));
	await fixture.assertUnchanged();
});

test("OMP role aliases resolve natively and large output defaults are not capped", async t => {
	const fixture = await nativeFixture(t);
	await fixture.replace("config.yml", { modelRoles: { default: "pi/slow", slow: "eval_native_one/default-model:high" } });
	const models = structuredClone(fixture.files["models.yml"]);
	Object.assign(models.providers.eval_native_one.models[0], { contextWindow: 262144, maxTokens: 128000 });
	await fixture.replace("models.yml", models);
	const model = await resolveOmpModel({ fromOmp: true, agentDir: "agent" }, fixture.root);
	assert.equal(model.id, "default-model");
	assert.equal(model.maxTokens, 128000);
	await fixture.assertUnchanged();
});

test("header-only native providers do not turn the no-auth sentinel into a credential", async t => {
	const fixture = await nativeFixture(t);
	const models = structuredClone(fixture.files["models.yml"]);
	models.providers.eval_native_one.auth = "none";
	await fixture.replace("models.yml", models);
	await fixture.replace("auth.json", {});
	const model = await resolveOmpModel({ fromOmp: true, agentDir: "agent" }, fixture.root);
	assert.equal(model.apiKey, undefined);
	assert.equal(model.headers["X-Gateway-Key"], "fixture-gateway-secret");
	await fixture.assertUnchanged();
});

test("fromOmp configuration produces credential-free report metadata and fails unknown selections", async t => {
	const fixture = await nativeFixture(t);
	const configPath = join(fixture.root, "config.json");
	const input = {
		version: 1, model: { fromOmp: true, agentDir: "agent" },
		sources: [{ id: "docs", kind: "reference", root: "source", files: ["guide.md"] }],
		questions: [{ id: "check", prompt: "What is documented?", expectedEvidence: [{ sourceId: "docs", path: "guide.md" }] }],
	};
	const original = `${JSON.stringify(input)}\n`;
	await writeFile(configPath, original);
	const config = await loadConfig(configPath);
	assert.equal(config.model.apiKey, "fixture-default-secret");
	const report = reportConfig(config), serialized = JSON.stringify(report);
	assert.equal(report.model.provider, "eval_native_one");
	assert.equal(report.model.api, "anthropic-messages");
	assert.ok(!serialized.includes("fixture-default-secret"));
	assert.ok(!serialized.includes("fixture-gateway-secret"));
	assert.ok(!Object.hasOwn(report.model, "apiKey"));
	assert.ok(!Object.hasOwn(report.model, "headers"));
	assert.equal(await readFile(configPath, "utf8"), original);
	await assert.rejects(resolveOmpModel({ fromOmp: true, agentDir: "agent", id: "missing-model" }, fixture.root), /OMP model not found/);
	await fixture.assertUnchanged();
});

test("expired OAuth credentials are rejected before token refresh or network access", async t => {
	const fixture = await nativeFixture(t);
	await fixture.replace("config.yml", { modelRoles: { default: "anthropic/default-model" } });
	await fixture.replace("models.yml", { providers: { anthropic: fixture.files["models.yml"].providers.eval_native_one } });
	await fixture.replace("auth.json", { anthropic: { type: "oauth", access: "sk-ant-oat-fixture-access", refresh: "fixture-refresh-secret", expires: 0 } });
	await assert.rejects(resolveOmpModel({ fromOmp: true, agentDir: "agent" }, fixture.root), /OAuth\/subscription authentication is not supported/);
	await fixture.assertUnchanged();
});

test("OAuth-only subscription providers fail explicitly even without stored tokens", async t => {
	const fixture = await nativeFixture(t);
	await fixture.replace("config.yml", { modelRoles: { default: "openai-codex/default-model" } });
	await fixture.replace("models.yml", { providers: { "openai-codex": fixture.files["models.yml"].providers.eval_native_one } });
	await fixture.replace("auth.json", {});
	await assert.rejects(resolveOmpModel({ fromOmp: true, agentDir: "agent" }, fixture.root), /OAuth\/subscription authentication is not supported/);
	await fixture.assertUnchanged();
});

test("API keys remain supported for dual-mode Anthropic but not Copilot subscription tokens", async t => {
	const fixture = await nativeFixture(t);
	for (const provider of ["anthropic", "github-copilot"]) {
		await fixture.replace("models.yml", { providers: { [provider]: fixture.files["models.yml"].providers.eval_native_one } });
		await fixture.replace("auth.json", { [provider]: { type: "api_key", key: "fixture-direct-key" } });
		const selection = { fromOmp: true, agentDir: "agent", provider, id: "default-model" };
		if (provider === "anthropic") assert.equal((await resolveOmpModel(selection, fixture.root)).apiKey, "fixture-direct-key");
		else await assert.rejects(resolveOmpModel(selection, fixture.root), /OAuth\/subscription authentication is not supported/);
		await fixture.assertUnchanged();
	}
});

test("Anthropic OAuth tokens passed as API keys or headers cannot bypass the auth boundary", async t => {
	const fixture = await nativeFixture(t);
	await fixture.replace("auth.json", { eval_native_one: { type: "api_key", key: "sk-ant-oat-disguised-secret" } });
	await assert.rejects(resolveOmpModel({ fromOmp: true, agentDir: "agent" }, fixture.root), /OAuth\/subscription authentication is not supported/);
	await fixture.replace("auth.json", fixture.files["auth.json"]);
	await fixture.replace("models.yml", { providers: { eval_native_one: { ...fixture.files["models.yml"].providers.eval_native_one, headers: { Authorization: "Bearer sk-ant-oat-header-secret" } } } });
	await assert.rejects(resolveOmpModel({ fromOmp: true, agentDir: "agent" }, fixture.root), /OAuth\/subscription authentication is not supported/);
	await fixture.assertUnchanged();
});
