import { describe, expect, it } from "vitest";
import { modelMatchesEndpoint } from "../../server/model-endpoint-availability.js";

describe("model endpoint availability", () => {
	it("excludes built-in Claude IDs when Anthropic requests go to DashScope", () => {
		const claude = { provider: "anthropic", id: "claude-opus-5-5" };
		expect(modelMatchesEndpoint(claude, "https://dashscope.aliyuncs.com/apps/anthropic")).toBe(false);
		expect(modelMatchesEndpoint(claude, "https://coding.dashscope.aliyuncs.com/apps/anthropic")).toBe(false);
		expect(modelMatchesEndpoint(claude, "https://workspace.cn-beijing.maas.aliyuncs.com/apps/anthropic")).toBe(false);
		expect(modelMatchesEndpoint(claude, "https://api.anthropic.com")).toBe(true);
		expect(modelMatchesEndpoint(claude, undefined)).toBe(true);
	});
	it("keeps other providers and explicitly named DashScope models", () => {
		const endpoint = "https://dashscope.aliyuncs.com/apps/anthropic";
		expect(modelMatchesEndpoint({ provider: "anthropic", id: "qwen3.7-plus" }, endpoint)).toBe(true);
		expect(modelMatchesEndpoint({ provider: "kimi-coding", id: "kimi-k2" }, endpoint)).toBe(true);
		expect(modelMatchesEndpoint({ provider: "anthropic", id: "claude-opus-5-5" }, "https://dashscope.aliyuncs.com.evil.test/apps/anthropic")).toBe(true);
	});
});
