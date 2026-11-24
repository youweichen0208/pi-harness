import { expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { lazyStream, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { isInvalidOutputBudgetError, outputTokenLimit, OutputBudgetError, resolveOutputBudget, withOutputTokenFloor, withReasoningEnabled } from "../../server/model-output-floor.js";

const model = (overrides: Partial<Model<Api>> = {}): Model<Api> => ({
	id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1:1",
	input: ["text"], reasoning: false, contextWindow: 200000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...overrides,
});
const context = (text = "Hello"): Context => ({ messages: [{ role: "user", content: text, timestamp: 1 }] });
const assistant = (m: Model<Api>, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage => ({
	role: "assistant", content: [], api: m.api, provider: m.provider, model: m.id, stopReason, errorMessage, timestamp: 1,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

it("preserves declarations by default, caps explicit limits, respects context size and supports legacy floors", () => {
	expect(outputTokenLimit(131072, 200000, {})).toBe(131072);
	expect(outputTokenLimit(4096, 200000, {})).toBe(4096);
	expect(outputTokenLimit(4096, 200000, { PI_MAX_TOKENS_FLOOR: "16384" })).toBe(16384);
	expect(outputTokenLimit(4096, 8192, {})).toBe(4096);
	expect(outputTokenLimit(4096, 200000, { PI_MAX_TOKENS: "128000", PI_MAX_TOKENS_FLOOR: "1" })).toBe(4096);
	expect(outputTokenLimit(200000, 300000, { PI_MAX_TOKENS: "128000" })).toBe(128000);
	expect(outputTokenLimit(4096, 200000, { PI_MAX_TOKENS: "0" })).toBe(4096);
	for (const value of ["0", "", "NaN", "-1", "1.5"]) expect(outputTokenLimit(4096, 32768, { PI_MAX_TOKENS_FLOOR: value })).toBe(4096);
});

it("projects native and built-in catalogs without changing SDK registration, auth, source models or reasoning", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-output-floor-"));
	try {
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { fixture: { api: "anthropic-messages", baseUrl: "http://localhost:8999", apiKey: "fixture", models: [{ id: "small", name: "small", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096 }] } } }));
		const original = await ModelRuntime.create({ modelsPath, authPath: join(dir, "auth.json"), allowModelNetwork: false });
		const env = { PI_MAX_TOKENS: "2048" } as NodeJS.ProcessEnv;
		const runtime = withOutputTokenFloor(original, env);
		expect(withOutputTokenFloor(runtime)).toBe(runtime);
		expect(runtime.getProvider("fixture")).toBe(original.getProvider("fixture"));
		expect(runtime.getRegisteredProviderIds()).toEqual(original.getRegisteredProviderIds());
		expect(await runtime.getAuth("fixture")).toEqual(await original.getAuth("fixture"));
		for (const list of [runtime.getModels(), runtime.getAllModels(), runtime.getAvailableSnapshot(), await runtime.getAvailable()]) {
			expect(list.find(m => m.provider === "fixture" && m.id === "small")).toMatchObject({ maxTokens: 2048, reasoning: false });
		}
		const enabled = withReasoningEnabled(runtime);
		expect(enabled.getModel("fixture", "small")).toMatchObject({ maxTokens: 2048, reasoning: true });
		expect(enabled.getModel("fixture", "small")?.reasoning).toBe(true);
		expect(runtime.getModel("fixture", "small")?.reasoning).toBe(false);
		const builtin = original.getModels().find(m => m.provider !== "fixture" && m.maxTokens < 128000 && m.contextWindow >= 128000);
		expect(builtin).toBeDefined();
		expect(runtime.getModel(builtin!.provider, builtin!.id)?.maxTokens).toBe(Math.min(2048, builtin!.maxTokens));
		expect(original.getModel("fixture", "small")?.maxTokens).toBe(4096);
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getPhysicalModel("fixture", "small")?.maxTokens).toBe(2048);
		expect(runtime.getModelOfType("chat", "fixture", "small")?.maxTokens).toBe(2048);
		delete env.PI_MAX_TOKENS;
		expect(runtime.getModel("fixture", "small")?.maxTokens).toBe(4096);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

it("resolves provider, user and inferred caps with explicit environment provenance", () => {
	const m = model();
	expect(resolveOutputBudget(m, context(), undefined, {})).toMatchObject({ source: "provider", resolvedBudget: 4096, sdkBudget: 4096 });
	expect(resolveOutputBudget(m, context(), { providerCap: 8192, userConfiguredCap: 32768 }, {})).toMatchObject({ source: "user-config", resolvedBudget: 8192, sdkBudget: 8192 });
	expect(resolveOutputBudget(m, context(), { inferred: true }, {})).toMatchObject({ source: "inferred", resolvedBudget: 8192, sdkBudget: 8192 });
	expect(resolveOutputBudget(m, context(), { userConfiguredCap: 4096 }, { PI_MAX_TOKENS_FLOOR: "16384" })).toMatchObject({ resolvedBudget: 16384, sdkBudget: 16384, override: "PI_MAX_TOKENS_FLOOR" });
	expect(resolveOutputBudget(m, context(), { userConfiguredCap: 4096 }, { PI_MAX_TOKENS: "2048", PI_MAX_TOKENS_FLOOR: "16384" })).toMatchObject({ resolvedBudget: 2048, sdkBudget: 2048, override: "PI_MAX_TOKENS" });
});

it("uses the SDK context clamp for fixed and dynamic safety margins without double clipping", () => {
	const m = model({ maxTokens: 200000 });
	const dynamic = resolveOutputBudget(m, context("x".repeat(400000)), undefined, {});
	expect(dynamic.resolvedBudget).toBe(200000);
	expect(dynamic.sdkBudget).toBe(200000 - dynamic.contextTokens - Math.max(4096, Math.ceil(dynamic.contextTokens * 0.15)));
	const ratioFallback = resolveOutputBudget(m, context("x".repeat(525000)), undefined, {});
	expect(ratioFallback.sdkBudget).toBe(32768);
});

it("rejects insufficient context and unsatisfiable explicit budgets before sending", () => {
	const small = model({ contextWindow: 32768 });
	for (const explicit of [undefined, 2048]) {
		let error: unknown;
		try { resolveOutputBudget(small, context("x".repeat(120000)), undefined, {}, explicit); } catch (caught) { error = caught; }
		expect(error).toBeInstanceOf(OutputBudgetError);
		expect((error as OutputBudgetError).code).toBe(explicit ? "explicit-budget-unavailable" : "context-insufficient");
	}
	expect(resolveOutputBudget(small, context(), { inferred: true }, {}, 16384).sdkBudget).toBe(16384);
});

it("classifies only explicit output-capability errors", () => {
	expect(isInvalidOutputBudgetError("max_tokens is too large for this model")).toBe(true);
	expect(isInvalidOutputBudgetError("max_output_tokens exceeds the supported maximum")).toBe(true);
	expect(isInvalidOutputBudgetError("input tokens exceed the model context window")).toBe(false);
	expect(isInvalidOutputBudgetError("invalid API key")).toBe(false);
});

function fallbackRuntime(m: Model<Api>, calls: number[], first: "empty-error" | "text-error") {
	return {
		streamSimple(_model: Model<Api>, _context: Context, options: { maxTokens: number }) {
			calls.push(options.maxTokens);
			return lazyStream(m, async () => (async function* () {
				if (calls.length === 1) {
					if (first === "text-error") {
						yield { type: "text_delta" as const, contentIndex: 0, delta: "Already consumed", partial: { ...assistant(m, "pending"), content: [{ type: "text" as const, text: "Already" }] } };
					}
					yield { type: "error" as const, reason: "error" as const, error: assistant(m, "error", "max_tokens is too large for this model") };
				} else {
					const message = { ...assistant(m, "stop"), content: [{ type: "text" as const, text: "Recovered" }] };
					yield { type: "done" as const, reason: "stop" as const, message };
				}
			})());
		},
	} as unknown as ModelRuntime;
}

it("retries an inferred invalid budget once with no output and records both budgets", async () => {
	const m = model(), calls: number[] = [];
	const runtime = fallbackRuntime(m, calls, "empty-error");
	const reserve = vi.fn(() => true), onBudget = vi.fn();
	const stream = withOutputTokenFloor(runtime, {}, { metadata: () => ({ inferred: true }), reserveAutomaticAction: reserve, onBudget }).streamSimple(m, context());
	const result = await stream.result();
	expect(result.stopReason).toBe("stop");
	expect(calls).toEqual([8192, 4096]);
	expect(reserve).toHaveBeenCalledTimes(1);
	expect(onBudget.mock.calls.map(call => call[1])).toMatchObject([{ resolvedBudget: 8192 }, { resolvedBudget: 4096, fallback: true }]);
});

it("never retries after consumable output or when the action budget is exhausted", async () => {
	for (const reserveValue of [true, false]) {
		const m = model(), calls: number[] = [];
		const runtime = fallbackRuntime(m, calls, "text-error");
		const reserve = vi.fn(() => reserveValue);
		const result = await withOutputTokenFloor(runtime, {}, { metadata: () => ({ inferred: true }), reserveAutomaticAction: reserve }).streamSimple(m, context()).result();
		expect(result.stopReason).toBe("error");
		expect(calls).toEqual([8192]);
		expect(reserve).not.toHaveBeenCalled();
	}
});

it("does not send a fallback request after the first rejection is aborted", async () => {
	const m = model(), calls: number[] = [], controller = new AbortController();
	const runtime = fallbackRuntime(m, calls, "empty-error");
	const reserve = vi.fn(() => { controller.abort(); return true; });
	await withOutputTokenFloor(runtime, {}, { metadata: () => ({ inferred: true }), reserveAutomaticAction: reserve }).streamSimple(m, context(), { signal: controller.signal }).result();
	expect(calls).toEqual([8192]);
	expect(reserve).toHaveBeenCalledTimes(1);
});
