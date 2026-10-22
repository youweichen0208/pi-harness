import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptReceipts } from "../../server/prompt-receipts.js";
const roots: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), "pi-receipts-")); roots.push(dir); return dir; }
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
it("claims before dispatch, replays results and isolates clients", () => {
	const dir = root(), store = new PromptReceipts(dir);
	expect(store.begin("a", "request", { text: "private prompt" })).toBeNull();
	expect(store.begin("a", "request", { text: "private prompt" })?.receipt).toBe("processing");
	expect(store.begin("a", "request", { text: "different" })?.receipt).toBe("conflict");
	const result = store.finish("a", { type: "prompt_result", requestId: "request", sessionId: "stable", ok: true });
	expect(new PromptReceipts(dir).query("a", "request")).toEqual(result);
	expect(store.query("b", "request").receipt).toBe("missing");
	expect(readFileSync(join(dir, "prompt-receipts.json"), "utf8")).not.toContain("private prompt");
});
it("restores an unfinished claim as unknown and never admits it again", () => {
	const dir = root(); new PromptReceipts(dir).begin("a", "id", { target: "session" });
	const restarted = new PromptReceipts(dir);
	expect(restarted.query("a", "id").receipt).toBe("unknown");
	expect(restarted.begin("a", "id", { target: "session" })?.receipt).toBe("unknown");
});
it("expires results without granting replay, and never expires processing claims", () => {
	let now = 1; const store = new PromptReceipts(root(), () => now);
	store.begin("a", "done", {}); store.finish("a", { type: "prompt_result", requestId: "done", ok: true });
	store.begin("a", "running", {}); now += 8 * 86400000;
	expect(store.query("a", "done").receipt).toBe("expired");
	expect(store.begin("a", "done", {})?.receipt).toBe("expired");
	expect(store.query("a", "running").receipt).toBe("processing");
});
it("fails closed on corruption, capacity and write failures", () => {
	const dir = root(); writeFileSync(join(dir, "prompt-receipts.json"), "broken");
	const broken = new PromptReceipts(dir);
	expect(() => broken.begin("a", "id", {})).toThrow();
	expect(broken.query("a", "id").receipt).toBe("unknown");
	const full = new PromptReceipts(root(), Date.now, 1); full.begin("a", "one", {});
	expect(() => full.begin("a", "two", {})).toThrow(/capacity/);
	const path = root(), failed = new PromptReceipts(path); failed.begin("a", "one", {});
	rmSync(join(path, "prompt-receipts.json")); mkdirSync(join(path, "prompt-receipts.json"));
	expect(failed.finish("a", { type: "prompt_result", requestId: "one", ok: true }).receipt).toBe("unknown");
	expect(failed.query("a", "one").receipt).toBe("unknown");
});

it("compares payload meaning independently of object key order", () => {
	const store = new PromptReceipts(root());
	store.begin("a", "id", { text: "hi", target: { cwd: "root", sessionId: "stable" } });
	expect(store.begin("a", "id", { target: { sessionId: "stable", cwd: "root" }, text: "hi" })?.receipt).toBe("processing");
});
