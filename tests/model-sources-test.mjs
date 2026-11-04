/** Portable discovery regression: also run with packaged Electron as Node. No real accounts/network. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.argv[2] || process.cwd());
const { ModelRuntime } = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")));
const { ModelSourceSync } = await import(pathToFileURL(join(root, "dist/server/model-source-sync.js")));
const home = mkdtempSync(join(tmpdir(), "pi-model-source-package-"));
const put = (file, data) => { const path = join(home, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data)); };
let unbind;
try {
	put(".claude/settings.json", { model: "example", env: { ANTHROPIC_API_KEY: "CLAUDE_SECRET" } });
	put(".codex/config.toml", 'model="example"\nmodel_provider="gateway"\n[model_providers.gateway]\nbase_url="http://localhost:9999/v1"\nenv_key="FIXTURE_KEY"\n');
	put(".config/opencode/opencode.jsonc", { provider: { gateway: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:9999/v1", apiKey: "OPEN_SECRET" }, models: { example: {} } } } });
	const options = { home, env: { FIXTURE_KEY: "CODEX_SECRET" } };
	const runtime = await ModelRuntime.create({ authPath: join(home, "pi/auth.json"), modelsPath: join(home, "pi/models.json"), allowModelNetwork: false });
	const sync = new ModelSourceSync(join(home, "data"), join(home, "pi"), options);
	let busy = false; unbind = await sync.bind(runtime, () => busy, () => {});
	assert.equal(sync.configs().length, 3);
	assert.equal((await runtime.getAvailable()).filter(m => m.provider.startsWith("sync-")).length, 3);
	const entry = sync.configs().find(p => p.origin.sources.includes("claude"));
	const id = entry.providerId;
	busy = true;
	put(".claude/replacement", { model: "example", env: { ANTHROPIC_API_KEY: "ROTATED_SECRET" } });
	renameSync(join(home, ".claude/replacement"), join(home, ".claude/settings.json"));
	await sync.sync();
	assert.equal((await runtime.getAuth(id)).auth.apiKey, "CLAUDE_SECRET");
	busy = false; await sync.ready(runtime);
	assert.equal((await runtime.getAuth(id)).auth.apiKey, "ROTATED_SECRET");
	const persisted = readFileSync(join(home, "data/model-sources.json"), "utf8");
	for (const secret of ["CLAUDE_SECRET", "ROTATED_SECRET", "CODEX_SECRET", "OPEN_SECRET"]) {
		assert(!persisted.includes(secret)); assert(!JSON.stringify(sync.configs()).includes(secret)); assert(!JSON.stringify(sync.status(runtime)).includes(secret));
	}
	await sync.edit(id, { ...entry, name: "Local" });
	rmSync(join(home, ".claude/settings.json")); await sync.sync();
	assert.equal(sync.configs().find(p => p.providerId === id).origin.mode, "local");
	await sync.edit(id); assert(!sync.configs().some(p => p.providerId === id));
	console.log("PASS packaged API discovery, runtime registration, atomic replacement, rotation, private persistence and detachment");
} finally { unbind?.(); rmSync(home, { recursive: true, force: true }); }
