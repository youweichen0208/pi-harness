import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { outputTokenLimit, withOutputTokenFloor } from "../../server/model-output-floor.js";

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

it("projects native and built-in catalogs without changing SDK registration, auth or source models", async () => {
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
			expect(list.find(m => m.provider === "fixture" && m.id === "small")).toMatchObject({ maxTokens: 2048 });
		}
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
