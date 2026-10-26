import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorkspaceCatalog } from "../../server/protocol.js";
import { promptWorkspaceTarget, selectedProjectWorkspace, selectProjectWorkspace } from "../../web/src/project-workspaces.js";

const target = { cwd: "/repos/orders", conversationId: "conversation", sessionId: "session", workspaceId: "business" };
const catalog: ProjectWorkspaceCatalog = {
	revision: 2,
	workspaces: [
		{ id: "business", name: "Business", paths: [target.cwd, "/repos/payments"] },
		{ id: "other", name: "Other", paths: [target.cwd, "/repos/other"] },
	],
};

afterEach(() => vi.unstubAllGlobals());

describe("prompt Workspace target at the send boundary", () => {
	it("preserves a captured Workspace before the catalog arrives", () => {
		const sent = promptWorkspaceTarget(target, null);
		expect(sent).toEqual(target);
		expect(JSON.parse(JSON.stringify(sent)).workspaceId).toBe("business");
		// Receiving the catalog after an asynchronous save does not change the target.
		expect(promptWorkspaceTarget(target, catalog)).toEqual(sent);
	});

	it("drops a known unrelated or deleted Workspace without retargeting the conversation", () => {
		for (const known of [
			{ revision: 3, workspaces: [] },
			{ revision: 3, workspaces: [{ id: "business", name: "Business", paths: ["/repos/payments"] }] },
		]) {
			expect(promptWorkspaceTarget(target, known)).toEqual({ ...target, workspaceId: undefined });
		}
	});

	it("does not infer a Workspace for an explicitly unscoped target", () => {
		const unscoped = { ...target, workspaceId: undefined };
		expect(promptWorkspaceTarget(unscoped, null)).toEqual(unscoped);
		expect(promptWorkspaceTarget(unscoped, catalog)).toEqual(unscoped);
	});

	it("keeps the click-time selection through a later local selection or another tab's preference write", () => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
		});
		selectProjectWorkspace("business");
		const captured = { ...target, workspaceId: selectedProjectWorkspace() };
		storage.set("pi-harness:project-workspace", "other");
		expect(selectedProjectWorkspace()).toBe("business");
		selectProjectWorkspace("other");
		expect(promptWorkspaceTarget(captured, catalog)).toEqual(target);
		expect(promptWorkspaceTarget(captured, null)).toEqual(target);
		expect(selectedProjectWorkspace()).toBe("other");
	});
});
