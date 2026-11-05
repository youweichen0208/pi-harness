import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { outputTokenLimit, withOutputTokenFloor } from "../../server/model-output-floor.js";

it("preserves higher limits, respects context size and allows disabling the floor", () => {
	expect(outputTokenLimit(65536, 200000, {})).toBe(65536);
	expect(outputTokenLimit(4096, 8192, {})).toBe(8192);
	for (const value of ["0", "", "NaN", "-1", "1.5"]) expect(outputTokenLimit(4096, 32768, { PI_MAX_TOKENS_FLOOR: value })).toBe(4096);
});

it("projects native and built-in catalogs without changing SDK registration, auth or source models", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-output-floor-"));
	try {
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { fixture: { api: "anthropic-messages", baseUrl: "http://localhost:8999", apiKey: "fixture", models: [{ id: "small", name: "small", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096 }] } } }));
		const original = await ModelRuntime.create({ modelsPath, authPath: join(dir, "auth.json"), allowModelNetwork: false });
		const env = {} as NodeJS.ProcessEnv;
		const runtime = withOutputTokenFloor(original, env);
		expect(withOutputTokenFloor(runtime)).toBe(runtime);
		expect(runtime.getProvider("fixture")).toBe(original.getProvider("fixture"));
		expect(runtime.getRegisteredProviderIds()).toEqual(original.getRegisteredProviderIds());
		expect(await runtime.getAuth("fixture")).toEqual(await original.getAuth("fixture"));
		for (const list of [runtime.getModels(), runtime.getAllModels(), runtime.getAvailableSnapshot(), await runtime.getAvailable()]) {
			expect(list.find(m => m.provider === "fixture" && m.id === "small")).toMatchObject({ maxTokens: 16384 });
		}
		const builtin = original.getModels().find(m => m.provider !== "fixture" && m.maxTokens < 16384 && m.contextWindow >= 16384);
		expect(builtin).toBeDefined();
		expect(runtime.getModel(builtin!.provider, builtin!.id)?.maxTokens).toBe(16384);
		expect(original.getModel("fixture", "small")?.maxTokens).toBe(4096);
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getPhysicalModel("fixture", "small")?.maxTokens).toBe(16384);
		expect(runtime.getModelOfType("chat", "fixture", "small")?.maxTokens).toBe(16384);
		env.PI_MAX_TOKENS_FLOOR = "0";
		expect(runtime.getModel("fixture", "small")?.maxTokens).toBe(4096);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
