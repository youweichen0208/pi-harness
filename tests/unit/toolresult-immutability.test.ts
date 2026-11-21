import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Admission evidence for identity-based cache revisions. These assertions prove
 * only that projections preserve object identities; an in-place rewrite would
 * preserve identity too and remains invisible to this test. `details` and
 * `nestedCalls` therefore keep their metadata hash contract.
 */
describe("toolResult persistence preserves identities", () => {
	it("keeps message, content array and nestedCalls identities across projections", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-immutability-"));
		try {
			const manager = SessionManager.create(dir);
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "read two files" }], timestamp: 1 });
			const toolResult = {
				role: "toolResult" as const,
				toolCallId: "call-1",
				toolName: "codemode",
				content: [{ type: "text" as const, text: "result body" }],
				isError: false,
				timestamp: 2,
				nestedCalls: {
					complete: true,
					calls: [{ id: "nested-1", name: "read", status: "ok" as const, durationMs: 3, arguments: { path: "a.ts" } }],
				},
			};
			manager.appendMessage(toolResult);

			const first = manager.buildSessionProjection().messages.at(-1);
			expect(first).not.toBeUndefined();
			expect(first).toBe(toolResult);

			const branch = manager.getBranch();
			const fromBranch = branch.at(-1);
			expect(fromBranch?.type).toBe("message");
			if (fromBranch?.type !== "message") throw new Error("expected a message entry");

			// Identity is what the cache relies on: same object, same array, same
			// nestedCalls summary — not merely the same serialized content.
			expect(fromBranch.message).toBe(first);
			expect(manager.buildSessionProjection().messages.at(-1)).toBe(first);
			expect(manager.buildSessionProjection().messages.at(-1)).toBe(toolResult);

			if (first?.role !== "toolResult") throw new Error("expected a toolResult message");
			expect(first.content).toBe(toolResult.content);
			expect(first.nestedCalls).toBe(toolResult.nestedCalls);
			expect(first.nestedCalls?.calls[0]).toBe(toolResult.nestedCalls.calls[0]);

			// Appending later entries must not re-project the earlier ones.
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "next" }], timestamp: 3 });
			const afterAppend = manager.buildSessionProjection().messages;
			expect(afterAppend.find((m) => m.role === "toolResult")).toBe(first);
			expect(afterAppend.find((m) => m.role === "toolResult")?.content).toBe(toolResult.content);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
