import { expect, it } from "vitest";
import { projectMessage, projectModel } from "../../server/omp/presentation.js";

it("exposes native truncation for the download control without forwarding artifact paths or arbitrary details", () => {
	const message = { role: "toolResult", toolCallId: "output", content: [{ type: "text", text: "preview" }], details: {
		exitCode: 2, password: "SECRET", meta: { truncation: { artifactId: "9", totalBytes: 900000 }, artifactError: { path: "/private/SECRET" } },
	} };
	const original = structuredClone(message);
	expect(projectMessage(message, 0)?.details).toEqual({ exitCode: 2, truncation: { truncated: true } });
	expect(JSON.stringify(projectMessage(message, 0))).not.toMatch(/SECRET|artifactId|totalBytes/);
	expect(message).toEqual(original);
});

it("projects model identity and capacity without leaking provider configuration", () => {
	const projected = projectModel({ provider: "fixture", id: "model", name: "Model", contextWindow: 200000, maxTokens: 128000,
		headers: { Authorization: "SECRET" }, apiKey: "SECRET", baseUrl: "https://example.test/?token=SECRET" });
	expect(projected).toEqual({ provider: "fixture", id: "model", name: "Model", contextWindow: 200000, maxTokens: 128000, reasoning: false, vision: false });
	expect(projectModel({ provider: "fixture", id: "unknown" })).toBeUndefined();
	expect(projectModel({ provider: "fixture", id: "native-unknown-capacity", contextWindow: null, maxTokens: null })).toMatchObject({ contextWindow: null, maxTokens: null });
	expect(projectModel({ provider: "fixture", id: "invalid", contextWindow: Infinity, maxTokens: 128000 })).toBeUndefined();
});
it("bounds browser content without changing native thinking, arguments or metadata", () => {
	const original = { role: "assistant", timestamp: 123, content: [
		{ type: "thinking", thinking: "reason", signature: "PRIVATE_SIGNATURE" },
		{ type: "toolCall", id: "call", name: "read", arguments: { path: "汉字🙂" } },
		{ type: "text", text: "x".repeat(200001) },
		{ type: "provider_metadata", token: "SECRET" },
	], usage: { input: 3, output: 8, cacheRead: 4, cacheWrite: 0, internal: "SECRET" }, headers: { token: "SECRET" } };
	const saved = structuredClone(original);
	const result = projectMessage(original, 0)!;
	expect(result.content).toHaveLength(3);
	expect(result.content[1]).toMatchObject({ type: "toolCall", id: "call", argumentsText: '{"path":"汉字🙂"}' });
	expect(result.content[2]).toMatchObject({ truncated: true });
	expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE_SIGNATURE/);
	expect(original).toEqual(saved);
	expect(projectMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }], details: { password: "SECRET" } }, 1)).toMatchObject({ id: "t-call", toolCallId: "call", toolName: "read" });
});

it("matches native history for empty cancellation events while retaining partial thinking", () => {
	expect(projectMessage({ role: "assistant", stopReason: "aborted", content: [] }, 0)).toBeUndefined();
	const content = [{ type: "thinking", thinking: "partial reasoning" }];
	expect(projectMessage({ role: "assistant", stopReason: "aborted", content }, 0)?.content).toEqual(content);
	expect(projectMessage({ role: "assistant", stopReason: "error", errorMessage: "provider failed", content: [] }, 0)?.errorMessage).toBe("provider failed");
});

it("keeps thinking timing aligned to native indices when other blocks are hidden", () => {
	const native = { role: "assistant", content: [{ type: "fallback", private: "SECRET" }, { type: "thinking", thinking: "reason", thinkingSignature: "PRIVATE_SIGNATURE" }] };
	expect(projectMessage(native, 0, undefined, { 1: 145 })?.content).toEqual([{ type: "thinking", thinking: "reason", durationMs: 145 }]);
	expect(projectMessage(native, 0)?.content).toEqual([{ type: "thinking", thinking: "reason" }]);
	expect(projectMessage(native, 0, undefined, { 1: NaN })?.content).toEqual([{ type: "thinking", thinking: "reason" }]);
	expect(native.content[1]).not.toHaveProperty("durationMs");
});

it("projects user-invoked skills as editable drafts without exposing the expanded body or private details", () => {
	const native = { role: "custom", customType: "skill-prompt", attribution: "user", timestamp: 123, content: [
		{ type: "text", text: "EXPANDED_SKILL_BODY" }, { type: "image", mimeType: "image/png", data: "AA==" },
	], details: { name: "fixture", path: "/private/SECRET", prompt: '/skill:fixture Inspect "a  b"\n\n<file path="saved.txt">\n```\nfrozen\n```\n</file>', token: "SECRET" } };
	const original = structuredClone(native);
	const result = projectMessage(native, 0, "native-skill")!;
	expect(result).toMatchObject({ role: "user", entryId: "native-skill", questionText: '/skill:fixture Inspect "a  b"', userAttachments: [{ preview: "frozen", nativeRef: { entryId: "native-skill", index: 0 } }] });
	expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" });
	expect(JSON.stringify(result)).not.toMatch(/EXPANDED_SKILL_BODY|SECRET/);
	expect(native).toEqual(original);
	for (const attribution of ["agent", undefined]) {
		const automatic = projectMessage({ ...native, attribution }, 0, "auto")!;
		expect(automatic.role).toBe("custom"); expect(automatic.userAttachments).toBeUndefined();
	}
	expect(projectMessage({ ...native, details: { name: "fixture", args: "old history" } }, 0)?.content[0]).toEqual({ type: "text", text: "/skill:fixture old history" });
	expect(projectMessage({ ...native, details: { name: "fixture", prompt: "Look at /skill:fixture now" } }, 0)?.content[0]).toEqual({ type: "text", text: "Look at /skill:fixture now" });
});

it("shows fixed ACP delegate notifications as events while preserving native input and entry identity", () => {
	for (const status of ["FAILED ⚠️", "completed"]) {
		const text = `[acp_delegate ${status}] **researcher** (runId \`del_fixture_123\`, exit ?) This is an automated system notification, NOT a user message.\n\nOriginal result.`;
		for (const content of [text, [{ type: "text", text }]]) {
			const native = { role: "user", content, timestamp: 123 };
			const original = structuredClone(native);
			const projected = projectMessage(native, 0, "notification-entry")!;
			expect(projected).toMatchObject({ role: "custom", customType: "acp-delegate", entryId: "notification-entry", content: [{ type: "text", text }] });
			expect(projected.questionText).toBeUndefined();
			expect(native).toEqual(original);
		}
	}
	for (const text of ["[acp_delegate completed] researcher (runId del_fixture, exit 0)", "This is an automated system notification, NOT a user message.", "Please explain [acp_delegate completed] researcher (runId del_fixture, exit 0) This is an automated system notification, NOT a user message."]) {
		expect(projectMessage({ role: "user", content: text }, 0)?.role).toBe("user");
	}
	const text = "[acp_delegate completed] researcher (runId del_fixture, exit 0) This is an automated system notification, NOT a user message.";
	expect(projectMessage({ role: "assistant", content: text }, 0)?.role).toBe("assistant");
	expect(projectMessage({ role: "custom", customType: "other", content: text }, 0)?.customType).toBe("other");
});
