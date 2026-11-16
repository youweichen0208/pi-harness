import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveOmpModel } from "./omp-model.mjs";

export function loopbackUrl(value, label) {
	let url;
	try { url = new URL(value); } catch { throw new Error(`${label}: expected a loopback HTTP URL`); }
	if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
		|| url.username || url.password || url.search || url.hash) {
		throw new Error(`${label}: use http://127.0.0.1 or http://[::1], without credentials, query or fragment`);
	}
	return url.href.replace(/\/$/, "");
}

function positiveInteger(value, fallback, label, maximum) {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`${label}: invalid positive integer`);
	return result;
}

export async function loadConfig(path, env = process.env) {
	const configPath = resolve(path);
	const data = JSON.parse(await readFile(configPath, "utf8"));
	if (data.version !== 1) throw new Error("Unsupported evaluation config version (expected 1)");
	if (data.model?.fromPi) throw new Error("model.fromPi is retired; select model.fromOmp and an OMP agentDir");
	if (!data.model || (data.model.fromOmp !== true && (typeof data.model.id !== "string" || !data.model.id.trim()))) throw new Error("model.id is required unless model.fromOmp=true");
	if (!Array.isArray(data.sources) || !data.sources.length) throw new Error("sources must be a nonempty explicit file allowlist");
	if (!Array.isArray(data.questions) || !data.questions.length) throw new Error("questions must not be empty");
	const sourceIds = new Set(data.sources.map((source) => source.id));
	if (sourceIds.size !== data.sources.length) throw new Error("Duplicate source id");
	const questionIds = new Set();
	for (const question of data.questions) {
		if (typeof question.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(question.id) || questionIds.has(question.id)) throw new Error("Invalid or duplicate question id");
		questionIds.add(question.id);
		if (typeof question.prompt !== "string" || !question.prompt.trim()) throw new Error(`${question.id}: prompt is required`);
		if (!Array.isArray(question.expectedEvidence)) throw new Error(`${question.id}: expectedEvidence must be an array`);
		if (question.expectInsufficient !== undefined && typeof question.expectInsufficient !== "boolean") throw new Error(`${question.id}: expectInsufficient must be boolean`);
		if (!question.expectedEvidence.length && question.expectInsufficient !== true) throw new Error(`${question.id}: provide expectedEvidence or expectInsufficient=true`);
		for (const expected of question.expectedEvidence) {
			const source = data.sources.find((item) => item.id === expected.sourceId);
			if (!source?.files?.includes(expected.path)) throw new Error(`${question.id}: expected evidence is not in source allowlist`);
		}
	}
	const model = data.model.fromOmp === true ? await resolveOmpModel(data.model, dirname(configPath)) : {
		baseUrl: loopbackUrl(data.model.baseUrl, "model.baseUrl"),
		id: data.model.id,
		contextWindow: data.model.contextWindow,
		maxTokens: data.model.maxTokens,
	};
	if (model.contextWindow !== undefined) model.contextWindow = positiveInteger(model.contextWindow, undefined, "model.contextWindow", Number.MAX_SAFE_INTEGER);
	if (model.maxTokens !== undefined) model.maxTokens = positiveInteger(model.maxTokens, undefined, "model.maxTokens", Number.MAX_SAFE_INTEGER);
	if (model.maxTokens >= model.contextWindow) throw new Error("model.maxTokens must be smaller than contextWindow");
	let openviking;
	if (data.openviking) {
		if (typeof data.openviking.version !== "string" || !data.openviking.version.trim()) throw new Error("openviking.version must record the installed version");
		if (data.openviking.apiKey !== undefined) throw new Error("Use openviking.apiKeyEnv instead of storing a key in evaluation config");
		const apiKeyEnv = data.openviking.apiKeyEnv;
		if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv))) throw new Error("Invalid openviking.apiKeyEnv");
		openviking = { url: loopbackUrl(data.openviking.url, "openviking.url"), version: data.openviking.version, apiKey: apiKeyEnv ? env[apiKeyEnv] : undefined };
	}
	return {
		version: 1, configPath, baseDir: dirname(configPath), model, openviking,
		sources: data.sources, questions: data.questions,
		timeoutMs: positiveInteger(data.timeoutMs, 120000, "timeoutMs", 3600000),
	};
}

// This is intentionally smaller than the runtime configuration: reports contain no credentials.
export function reportConfig(config) {
	return {
		version: config.version, model: {
			fromOmp: config.model.fromOmp === true, provider: config.model.provider,
			id: config.model.id, api: config.model.api ?? "openai-completions", baseUrl: config.model.baseUrl,
			contextWindow: config.model.contextWindow, maxTokens: config.model.maxTokens,
		}, timeoutMs: config.timeoutMs,
		openviking: config.openviking ? { url: config.openviking.url, version: config.openviking.version } : null,
		questionCount: config.questions.length,
	};
}
