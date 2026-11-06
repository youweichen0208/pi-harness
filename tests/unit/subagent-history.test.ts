import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TaskRecord, taskDetail } from "../../server/subagents/tasks.js";
import { inheritedTaskDetail } from "../../server/subagents/history.js";
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "subagent-history-")); vi.stubEnv("PI_WEB_DATA_DIR", root); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function fixture() {
	const manager = SessionManager.create(root, join(root, "sessions"));
	const first = manager.appendMessage({ role: "user", content: "Investigate", timestamp: Date.now() });
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "subagent", arguments: { action: "run" } }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
	const record = new TaskRecord(manager.getSessionId(), "call", first, { sourceId: "repo", source: "Repo", root, task: "Full instructions".repeat(100), phase: "running" }, () => {});
	const result = { ...record.data.task, status: "completed" as const, text: "Report", durationMs: 1, evidenceStatus: "unverified" as const, truncated: false };
	await record.finish(result);
	manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "subagent", content: [{ type: "text", text: "Report" }], details: JSON.parse(JSON.stringify({ subagents: [result] })), isError: false, timestamp: Date.now() });
	return { manager, record, first };
}
test("real SDK clone/fork and multiple generations read original records without copying or writing ancestors", async () => {
	const { manager, record } = await fixture();
	const originalPath = manager.getSessionFile()!;
	const original = await readFile(originalPath, "utf8");
	const fork = SessionManager.forkFrom(originalPath, root, join(root, "sessions"));
	for (let i = 0; i < 3; i++) {
		fork.createBranchedSession(fork.getLeafId()!);
		const restored = SessionManager.open(fork.getSessionFile()!);
		const detail = await inheritedTaskDetail(restored, record.id);
		expect(detail.task.task).toBe(record.data.task.task);
		expect(detail.task.phase).toBe("completed");
		await expect(taskDetail(restored.getSessionId(), record.id, new Set(["call"]), 0, true)).rejects.toThrow();
	}
	expect(await readFile(originalPath, "utf8")).toBe(original);
});
test("current branch must contain the exact terminal task and parent call", async () => {
	const { manager, record, first } = await fixture();
	manager.createBranchedSession(manager.getLeafId()!);
	manager.branch(first);
	await expect(inheritedTaskDetail(manager, record.id)).rejects.toThrow(/branch/);
});
test("deleted records and ancestor identity cycles are unavailable without modifying history", async () => {
	const { manager, record } = await fixture();
	const id = manager.getSessionId(), originalPath = manager.getSessionFile()!;
	manager.createBranchedSession(manager.getLeafId()!);
	const recordPath = join(root, "subagent-tasks", createHash("sha256").update(id).digest("hex"), `${record.id}.json`);
	await rm(recordPath);
	await expect(inheritedTaskDetail(manager, record.id)).rejects.toThrow(/unavailable/);
	const lines = (await readFile(originalPath, "utf8")).trim().split("\n");
	lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), parentSession: originalPath });
	await writeFile(originalPath, lines.join("\n") + "\n");
	await expect(inheritedTaskDetail(manager, record.id)).rejects.toThrow(/cycle/);
});
test("ancestor running journals are rejected, never repaired or stopped", async () => {
	const { manager, record } = await fixture();
	const path = join(root, "subagent-tasks", createHash("sha256").update(manager.getSessionId()).digest("hex"), `${record.id}.json`);
	const data = JSON.parse(await readFile(path, "utf8")); data.task.phase = "running";
	const original = JSON.stringify(data); await writeFile(path, original);
	manager.createBranchedSession(manager.getLeafId()!);
	await expect(inheritedTaskDetail(manager, record.id)).rejects.toThrow(/not terminal/);
	expect(await readFile(path, "utf8")).toBe(original);
});
test("ancestry lookup stops after 32 generations", async () => {
	const { manager, record } = await fixture();
	for (let i = 0; i < 33; i++) manager.createBranchedSession(manager.getLeafId()!);
	await expect(inheritedTaskDetail(manager, record.id)).rejects.toThrow(/ancestry limit/);
});
