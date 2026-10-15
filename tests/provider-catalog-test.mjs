/** Exercise each catalog producer without network or user configuration. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelAdminService } from "../dist/server/model-admin.js";
import { ClientSession } from "../dist/server/agent-service.js";
import { NodeAgent } from "../dist/server/node-agent.js";
import { SlashCommandsService } from "../dist/server/slash-commands.js";

const directory = mkdtempSync(join(tmpdir(), "provider-catalog-"));
try {
	const models = [
		{ provider: "openai-codex", id: "legacy", name: "Legacy" },
		{ provider: "openai", id: "codex", name: "Codex" },
		{ provider: "custom-codex", id: "codex", name: "Custom Codex" },
	];
	const runtime = {
		getAvailable: async () => models,
		getAvailableSnapshot: () => models,
		getProviders: () => models.map(m => ({ id: m.provider, name: m.name, auth: { oauth: true } })),
		getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
	};
	const auth = JSON.stringify({ "openai-codex": { type: "api_key", key: "fixture-legacy" } });
	const config = JSON.stringify({ providers: Object.fromEntries(models.map(m => [m.provider, { models: [{ id: m.id }] }])) });
	writeFileSync(join(directory, "auth.json"), auth);
	writeFileSync(join(directory, "models.json"), config);
	const wire = [];
	const admin = new ModelAdminService({ agentDir: directory, modelRuntime: () => runtime, emit: m => wire.push(m) });
	await admin.listProviders();
	assert.deepEqual(wire.at(-1).providers.map(p => p.id), ["openai", "custom-codex"]);
	assert(wire.at(-1).providers[0].oauth);
	await admin.listModelsConfig();
	assert.deepEqual(wire.at(-1).providers.map(p => p.providerId), ["openai", "custom-codex"]);
	await ClientSession.prototype.listModels.call({ runtime: { services: { modelRuntime: runtime } }, emit: m => wire.push(m) });
	assert.deepEqual(wire.at(-1).models.map(m => m.provider), ["openai", "custom-codex"]);
	const session = { model: models[0], messages: [], modelRuntime: runtime };
	let nodeState;
	NodeAgent.prototype.refresh.call({ session, retain: m => m, set: s => { nodeState = s; } });
	assert.deepEqual(nodeState.models.map(m => m.provider), ["openai", "custom-codex"]);
	assert.equal(nodeState.model.provider, "openai-codex");
	let selected;
	const slash = new SlashCommandsService({ getSession: () => session, emit: m => wire.push(m), setModel: async id => { selected = id; } });
	await slash.exec("model", "codex", {});
	assert.equal(selected, "openai/codex");
	selected = undefined;
	await slash.exec("model", "openai-codex/legacy", {});
	assert.equal(selected, undefined);
	await slash.exec("model", "", {});
	assert(wire.at(-1).text.includes("openai-codex/legacy"));
	assert.equal(session.model, models[0]);
	assert.equal(readFileSync(join(directory, "auth.json"), "utf8"), auth);
	assert.equal(readFileSync(join(directory, "models.json"), "utf8"), config);
	console.log("PASS management/setup, chat, SSH and slash catalogs exclude only legacy provider; credentials, config and current model preserved");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
