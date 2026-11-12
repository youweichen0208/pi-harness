import { describe, expect, it } from "vitest";
import { mergeChatProvider, readModelCompat } from "../../server/model-config-merge.js";

describe("chat provider editing", () => {
	it("projects only safe compatibility fields including explicit false", () => {
		expect(readModelCompat({ supportsMessageThreads: false, promptCacheKeyMode: "disabled", headers: { Authorization: "secret" }, futureField: "secret", requiresToolsWithToolHistory: "true" })).toEqual({ supportsMessageThreads: false, promptCacheKeyMode: "disabled" });
	});
	it("patches selected compatibility fields and removes only explicit inheritance overrides", () => {
		const compat = { futureField: { keep: true }, supportsMessageThreads: true, promptCacheKeyMode: "enabled" };
		const previous = { compat, models: [{ id: "chat", compat }] };
		const modelCompat = { supportsMessageThreads: false, promptCacheKeyMode: null, requiresToolsWithToolHistory: true } as const;
		expect(mergeChatProvider(previous, { providerId: "fixture", compat: { supportsMessageThreads: null }, models: [{ id: "chat", compat: modelCompat }] })).toEqual({ compat: { futureField: { keep: true }, promptCacheKeyMode: "enabled" }, models: [{ id: "chat", compat: { futureField: { keep: true }, supportsMessageThreads: false, requiresToolsWithToolHistory: true } }] });
		expect(mergeChatProvider(previous, { providerId: "fixture", models: [{ id: "chat" }] })).toEqual(previous);
		expect(mergeChatProvider({}, { providerId: "fixture", compat: { supportsMessageThreads: null }, models: [{ id: "chat" }] })).toEqual({ models: [{ id: "chat" }] });
	});
	it("rejects malformed compatibility input without applying it", () => {
		const config = JSON.parse('{"providerId":"fixture","models":[{"id":"chat","compat":{"requiresToolsWithToolHistory":"false"}}]}');
		expect(() => mergeChatProvider({}, config)).toThrow("Invalid compatibility");
	});
	it("preserves typed operations, provider metadata and unknown chat fields", () => {
		const image = { id: "picture", type: "image", api: "openai-images", maxImages: 3 };
		const classifier = { id: "label", type: "classifier", samplingParams: { temperature: 0 } };
		const previous = { headers: { Authorization: "fixture" }, apiKey: "fixture-key", models: [{ id: "chat", type: "chat", cost: { input: 2 }, samplingParams: { temperature: 0.1 } }, image, classifier], operations: { image: { enabled: true } } };
		const result = mergeChatProvider(previous, { providerId: "fixture", api: "openai-completions", models: [{ id: "chat", name: "Renamed", reasoning: false }] });
		expect(result).toEqual({ ...previous, api: "openai-completions", models: [{ id: "chat", type: "chat", cost: { input: 2 }, samplingParams: { temperature: 0.1 }, name: "Renamed", reasoning: false }, image, classifier] });
	});
	it("removes deleted chat rows, retaining non-chat rows", () => {
		expect(mergeChatProvider({ models: [{ id: "old" }, { id: "image", type: "image" }] }, { providerId: "fixture", models: [{ id: "new" }] }).models).toEqual([{ id: "new" }, { id: "image", type: "image" }]);
	});
	it("allows IDs shared across operations and rejects duplicate chat IDs", () => {
		expect(mergeChatProvider({ models: [{ id: "shared", type: "image" }, { id: "shared", type: "chat", cost: { input: 1 } }] }, { providerId: "fixture", models: [{ id: "shared", name: "Edited" }] }).models).toEqual([{ id: "shared", type: "chat", cost: { input: 1 }, name: "Edited" }, { id: "shared", type: "image" }]);
		expect(() => mergeChatProvider({}, { providerId: "fixture", models: [{ id: "a" }, { id: " a " }] })).toThrow("Duplicate");
	});
});
