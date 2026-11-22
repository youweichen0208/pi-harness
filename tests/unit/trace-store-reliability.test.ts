import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore, type TraceStoreRecord } from "../../server/trace-store.js";

function record(sessionId: string, runId: string, seq: number, type: TraceStoreRecord["type"], payload: Record<string, unknown> = {}): TraceStoreRecord {
	return { schemaVersion: 1, sessionId, runId, seq, type, recordedAt: new Date().toISOString(), payload };
}
function settledRun(sessionId: string, runId: string, start: number): Record<string, unknown> {
	return { runId, sessionId, agentStartMs: start, agentSettledMs: start + 5, status: "measured", requests: [], tools: [], hostSpans: [], aggregates: {} };
}
function appendSettled(store: TraceStore, sessionId: string, runId: string, start: number): void {
	const run = settledRun(sessionId, runId, start);
	expect(store.append(record(sessionId, runId, 1, "run_start", { run: { runId, sessionId, agentStartMs: start } }))).toBe(true);
	expect(store.append(record(sessionId, runId, 2, "run_settled", { run }))).toBe(true);
}
function traceFile(directory: string, sessionId: string): string {
	return join(directory, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.jsonl`);
}

describe("TraceStore reliability", () => {
	it("retains the latest runs through repeated compaction and a fresh reopen", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-reliability-"));
		try {
			const store = new TraceStore(dir, { maxFileBytes: 600, maxRuns: 50 });
			const ids: string[] = [];
			for (let index = 0; index < 120; index++) {
				const runId = randomUUID(); ids.push(runId);
				appendSettled(store, "session", runId, index * 10);
			}
			const result = store.readSession("session");
			expect(result.runs).toHaveLength(50);
			expect(result.runs.map(run => run.runId)).toEqual(ids.slice(-50));
			expect(result.status).toMatchObject({ state: "ready", appendAttempts: 240, appendedRecords: 240 });
			expect(result.status.compactions!).toBeGreaterThan(20);
			const reopened = new TraceStore(dir).readSession("session");
			expect(reopened.runs.map(run => run.runId)).toEqual(ids.slice(-50));

			const activeId = randomUUID();
			store.append(record("session", activeId, 1, "run_start", { run: { runId: activeId, sessionId: "session", agentStartMs: 2000 } }));
			store.append(record("session", activeId, 2, "provider_request", { request: { requestId: "request", status: "open" } }));
			store.append(record("session", activeId, 3, "tool_end", { tool: { toolCallId: "tool", toolName: "bash", status: "measured" } }));
			expect(store.readSession("session").runs.find(run => run.runId === activeId)).toMatchObject({ status: "interrupted", requests: [{ requestId: "request" }], tools: [{ toolCallId: "tool" }] });
			store.append(record("session", activeId, 4, "run_settled", { run: settledRun("session", activeId, 2000) }));
			expect(store.readSession("session").runs.find(run => run.runId === activeId)?.status).toBe("measured");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("isolates an append fault and recovers on a later write", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-reliability-"));
		try {
			let warnings = 0;
			const store = new TraceStore(dir, { onDegraded: () => { warnings += 1; } });
			appendSettled(store, "healthy", randomUUID(), 1);
			const blocked = traceFile(dir, "blocked");
			mkdirSync(blocked);
			const runId = randomUUID();
			const start = record("blocked", runId, 1, "run_start", { run: { runId, sessionId: "blocked", agentStartMs: 1 } });
			expect(store.append(start)).toBe(false);
			expect(store.getStatus().state).toBe("degraded");
			expect(store.readSession("healthy").runs).toHaveLength(1);
			rmSync(blocked, { recursive: true });
			expect(store.append(start)).toBe(true);
			store.append(record("blocked", runId, 2, "run_settled", { run: settledRun("blocked", runId, 1) }));
			expect(store.readSession("blocked").runs[0]).toMatchObject({ runId, status: "measured" });
			expect(store.getStatus().state).toBe("ready");
			expect(warnings).toBe(1);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("keeps appended runs readable after a compaction write fault and compacts after recovery", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-reliability-"));
		try {
			let warnings = 0;
			const store = new TraceStore(dir, { maxFileBytes: 800, maxRuns: 10, onDegraded: () => { warnings += 1; } });
			appendSettled(store, "session", randomUUID(), 1);
			const file = traceFile(dir, "session"), temporary = `${file}.${process.pid}.tmp`;
			mkdirSync(temporary);
			const second = randomUUID();
			store.append(record("session", second, 1, "run_start", { run: { runId: second, sessionId: "session", agentStartMs: 20 } }));
			expect(store.append(record("session", second, 2, "run_settled", { run: settledRun("session", second, 20) }))).toBe(false);
			expect(store.getStatus().state).toBe("degraded");
			expect(store.readSession("session").runs.find(run => run.runId === second)?.status).toBe("measured");
			rmSync(temporary, { recursive: true });
			appendSettled(store, "session", randomUUID(), 40);
			expect(store.getStatus()).toMatchObject({ state: "ready" });
			expect(store.getStatus().compactions!).toBeGreaterThan(0);
			expect(new TraceStore(dir).readSession("session").runs).toHaveLength(3);
			expect(warnings).toBe(1);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("degrades on a real prune fault without rolling back the append, then prunes successfully", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-reliability-"));
		try {
			const store = new TraceStore(dir, { maxTotalBytes: 1, maxFileBytes: 10000 });
			appendSettled(store, "old", randomUUID(), 1);
			const oldFile = traceFile(dir, "old");
			rmSync(oldFile); mkdirSync(oldFile); writeFileSync(join(oldFile, "child"), "blocks non-recursive removal");
			const current = randomUUID();
			expect(store.append(record("current", current, 1, "run_start", { run: { runId: current, sessionId: "current", agentStartMs: 20 } }))).toBe(false);
			expect(store.getStatus().state).toBe("degraded");
			expect(readFileSync(traceFile(dir, "current"), "utf8")).toContain(current);
			rmSync(oldFile, { recursive: true, force: true });
			writeFileSync(join(dir, "stale.jsonl"), "");
			store.append(record("current", current, 2, "run_settled", { run: settledRun("current", current, 20) }));
			expect(store.getStatus()).toMatchObject({ state: "ready", prunedFiles: 1 });
			expect(readdirSync(dir).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);
			expect(new TraceStore(dir).readSession("current").runs[0]).toMatchObject({ runId: current, status: "measured" });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});
