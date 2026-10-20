import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WikiChatStore } from "../../server/wiki-chat-store.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "wiki-chat-store-")); roots.push(root);
	const cwd = join(root, "workspace"), other = join(root, "other"); mkdirSync(cwd); mkdirSync(other);
	writeFileSync(join(cwd, "note.md"), "# Note"); writeFileSync(join(other, "outside.md"), "# Outside");
	const store = new WikiChatStore(join(root, "wiki"));
	return { root, cwd, other, store };
}
describe("independent Wiki history", () => {
	it("persists native sessions and reference settings across store instances, without listing empty sessions", async () => {
		const { root, cwd, store } = fixture();
		const manager = SessionManager.create(cwd, store.directory(cwd));
		expect(await store.list(cwd)).toEqual([]);
		manager.appendMessage({ role: "user", content: "Compare sources", timestamp: Date.now() });
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Comparison" }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
		const id = manager.getSessionId();
		store.update(cwd, id, { title: "Research", references: ["note.md"] });
		const restored = new WikiChatStore(join(root, "wiki"));
		expect((await restored.list(cwd))[0]).toMatchObject({ id, title: "Research", references: ["note.md"] });
		expect(SessionManager.open(restored.file(cwd, id)).getSessionId()).toBe(id);
		restored.remove(cwd, id);
		expect(await restored.list(cwd)).toEqual([]);
		expect(existsSync(join(cwd, "note.md"))).toBe(true);
	});
	it("normalizes aliases, rejects missing and escaped paths, and caps selections", () => {
		const { cwd, other, store } = fixture();
		expect(store.validateReferences(cwd, ["note.md", "./note.md"])).toEqual(["note.md"]);
		expect(() => store.validateReferences(cwd, ["missing.md"])).toThrow();
		expect(() => store.validateReferences(cwd, ["../other/outside.md"])).toThrow(/outside workspace/);
		symlinkSync(join(other, "outside.md"), join(cwd, "escape.md"));
		expect(() => store.validateReferences(cwd, ["escape.md"])).toThrow(/outside workspace/);
		expect(() => store.validateReferences(cwd, Array(101).fill("note.md"))).toThrow(/maximum 100/);
	});
	it("isolates workspaces and rejects arbitrary session paths", () => {
		const { cwd, other, store } = fixture();
		expect(store.directory(cwd)).not.toBe(store.directory(other));
		for (const id of ["../escape", "", "/tmp/session.jsonl"]) expect(() => store.file(cwd, id)).toThrow(/Invalid Wiki session/);
	});
});
