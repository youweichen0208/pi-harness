import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { kNoAuth } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

async function copyCredentialDatabase(source, destination) {
	const suffixes = ["", "-wal", "-journal"];
	const fingerprint = async path => {
		try {
			const info = await stat(path, { bigint: true });
			if (!info.isFile()) throw new Error("OMP credential storage is not a regular file");
			return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
		} catch (error) { if (error.code === "ENOENT") return null; throw error; }
	};
	// Opening even a read-only WAL database can create source sidecars. Copy the
	// database AND recovery logs, with metadata checks spanning every byte read.
	// A concurrently changing source fails closed rather than mixing generations.
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = await Promise.all(suffixes.map(suffix => fingerprint(source + suffix)));
		let bytes;
		try { bytes = await Promise.all(suffixes.map((suffix, i) => before[i] === null ? null : readFile(source + suffix))); }
		catch (error) { if (error.code === "ENOENT") continue; throw error; }
		const after = await Promise.all(suffixes.map(suffix => fingerprint(source + suffix)));
		if (before.some((value, i) => value !== after[i])) continue;
		if (bytes[0] === null && bytes.some(value => value !== null)) throw new Error("OMP credential database is missing beside recovery logs");
		for (const [i, value] of bytes.entries()) if (value !== null) await writeFile(destination + suffixes[i], value, { mode: 0o600, flag: "wx" });
		return;
	}
	throw new Error("OMP credential storage changed during snapshot; retry when idle");
}

/** Resolve from a stable private copy; native migration/refresh never touches the source. */
export async function resolveOmpModel(selection) {
	const agentDir = selection.agentDir;
	const directory = process.env.PI_CODING_AGENT_DIR;
	const settings = await Settings.loadReadOnly({ agentDir, cwd: process.env.CONTEXT_EVAL_DIRECTORY });
	const saved = settings.getModelRole("default") ?? "";
	await copyCredentialDatabase(getAgentDbPath(agentDir), join(directory, "agent.db"));
	let models = {};
	try { models = Bun.YAML.parse(await readFile(join(agentDir, "models.yml"), "utf8")) ?? {}; }
	catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot read OMP models.yml"); }
	await writeFile(join(directory, "models.yml"), JSON.stringify(models), { mode: 0o600 });
	const auth = await AuthStorage.create(join(directory, "agent.db"), {
		refreshOAuthCredential: async () => { throw new Error("Evaluation OAuth refresh is disabled"); },
		usageFetch: async () => { throw new Error("Evaluation usage discovery is disabled"); },
	});
	try {
		await auth.credentials.reload();
		const registry = new ModelRegistry(auth, join(directory, "models.yml"), { settings: Settings.isolated(), fetch: () => { throw new Error("Model discovery is disabled in evaluation"); } });
		const defaultModel = selection.provider && selection.id ? undefined : resolveModelRoleValue(saved, registry.getAll(), { settings }).model;
		const provider = selection.provider ?? defaultModel?.provider;
		const id = selection.id ?? defaultModel?.id;
		if (!provider || !id) throw new Error("Select model.provider/model.id or configure OMP modelRoles.default");
		const unsupportedAuth = "Context evaluation supports API-key/header providers only; OAuth/subscription authentication is not supported";
		const definition = getProviderDefinition(provider);
		if (auth.credentials.hasSubscription(provider) || provider === "github-copilot" || (definition?.login && provider !== "anthropic")) throw new Error(unsupportedAuth);
		const model = registry.find(provider, id);
		if (!model) throw new Error(`OMP model not found: ${provider}/${id}`);
		if (!["openai-completions", "anthropic-messages", "openai-responses"].includes(model.api)) throw new Error(`Evaluation does not support OMP model API: ${model.api}`);
		const credentials = await registry.getApiKeyAndHeaders(model);
		if (!credentials.ok) throw new Error(`OMP credentials unavailable for provider ${provider}`);
		const headers = { ...model.headers, ...credentials.headers };
		const values = [credentials.apiKey, ...Object.entries(headers).filter(([name]) => /^(authorization|x-api-key)$/i.test(name)).map(([, value]) => value)];
		if (model.api === "anthropic-messages" && values.some(value => typeof value === "string" && value.includes("sk-ant-oat"))) throw new Error(unsupportedAuth);
		let url;
		try { url = new URL(model.baseUrl); } catch { throw new Error("OMP model needs a configured HTTP(S) base URL"); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("OMP model URL must not contain credentials, query or fragment");
		return {
			fromOmp: true, provider, id, api: model.api, baseUrl: url.href.replace(/\/$/, ""),
			contextWindow: selection.contextWindow ?? model.contextWindow, maxTokens: selection.maxTokens ?? model.maxTokens,
			apiKey: credentials.apiKey === kNoAuth ? undefined : credentials.apiKey, headers, compat: model.compat,
		};
	} finally { auth.close(); }
}
