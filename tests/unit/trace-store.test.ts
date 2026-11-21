import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TraceStore, type TraceStoreRecord } from "../../server/trace-store.js";

function record(sessionId: string, runId: string, seq: number, type: TraceStoreRecord["type"], payload: Record<string, unknown> = {}): TraceStoreRecord {
	return { schemaVersion: 1, sessionId, runId, seq, type, recordedAt: new Date().toISOString(), payload };
}

function settledRun(sessionId: string, runId: string, start: number): Record<string, unknown> {
	return { runId, sessionId, agentStartMs: start, agentSettledMs: start + 10, status: "measured", requests: [], tools: [], hostSpans: [], aggregates: {} };
}

describe("TraceStore", () => {
	it("recovers unfinished runs as interrupted and keeps settled runs complete", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-store-"));
		try {
			const store = new TraceStore(dir);
			const runId = randomUUID();
			store.append(record("session", runId, 1, "run_start", { run: { runId, sessionId: "session", agentStartMs: 1 } }));
			store.append(record("session", runId, 2, "provider_request", { request: { requestId: "request", status: "measured" } }));
			let result = store.readSession("session");
			expect(result.runs[0]).toMatchObject({ runId, status: "interrupted", interrupted: true, requests: [{ requestId: "request" }] });
			expect((result.runs[0] as any).aggregates.host_wall_union_ms).toMatchObject({ value: null, status: "unmeasured", reason: "run_interrupted" });
			store.append(record("session", runId, 3, "run_settled", { run: settledRun("session", runId, 1) }));
			result = store.readSession("session");
			expect(result.runs[0]).toMatchObject({ runId, status: "measured" });
			expect(result.status).toMatchObject({ appendAttempts: 3, appendedRecords: 3, compactions: 0, prunedFiles: 0 });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("deduplicates sequence numbers and marks gaps incomplete", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-store-"));
		try {
			const store = new TraceStore(dir), runId = randomUUID();
			const start = record("session", runId, 1, "run_start", { run: { runId, agentStartMs: 1 } });
			store.append(start); store.append(start);
			store.append(record("session", runId, 3, "tool_end", { tool: { toolCallId: "tool", status: "measured" } }));
			expect(store.readSession("session").runs[0]).toMatchObject({ status: "interrupted", incomplete: true, tools: [{ toolCallId: "tool" }] });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("recovers a malformed trailing append but quarantines middle corruption", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-store-"));
		try {
			const store = new TraceStore(dir), runId = randomUUID();
			store.append(record("session", runId, 1, "run_start", { run: { runId, agentStartMs: 1 } }));
			const file = readdirSync(dir).find(name => name.endsWith(".jsonl"))!;
			const path = join(dir, file);
			appendFileSync(path, '{"runId":');
			expect(store.readSession("session").runs[0]).toMatchObject({ status: "interrupted", recoveredTrailingWrite: true });
			writeFileSync(path, JSON.stringify(record("session", runId, 1, "run_start", { run: { runId } })) + "\nnot-json\n" + JSON.stringify(record("session", runId, 2, "tool_end", { tool: {} })) + "\n");
			expect(store.readSession("session").runs).toEqual([]);
			expect(store.getStatus().state).toBe("degraded");
			expect(readdirSync(dir).some(name => name.includes(".corrupt-"))).toBe(true);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("compacts only complete runs and never drops an active run", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-store-"));
		try {
			const store = new TraceStore(dir, { maxFileBytes: 300, maxRuns: 2 });
			for (let index = 0; index < 3; index++) {
				const runId = randomUUID(), run = settledRun("session", runId, index * 100);
				store.append(record("session", runId, 1, "run_start", { run }));
				store.append(record("session", runId, 2, "run_settled", { run }));
			}
			const activeId = randomUUID();
			store.append(record("session", activeId, 1, "run_start", { run: { runId: activeId, sessionId: "session", agentStartMs: 500 } }));
			const runs = store.readSession("session").runs;
			expect(runs.length).toBeLessThanOrEqual(3);
			expect(runs.some(run => run.runId === activeId && run.status === "interrupted")).toBe(true);
			expect(readFileSync(join(dir, readdirSync(dir).find(name => name.endsWith(".jsonl"))!), "utf8")).toContain(activeId);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("compacts historical interrupted runs instead of letting them block retention", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-store-"));
		try {
			const store = new TraceStore(dir, { maxFileBytes: 300, maxRuns: 2 });
			const interruptedId = randomUUID();
			store.append(record("session", interruptedId, 1, "run_start", { run: { runId: interruptedId, sessionId: "session", agentStartMs: 1 } }));
			for (let index = 0; index < 3; index++) {
				const runId = randomUUID(), run = settledRun("session", runId, index * 100);
				store.append(record("session", runId, 1, "run_start", { run: { runId, sessionId: "session", agentStartMs: run.agentStartMs } }));
				store.append(record("session", runId, 2, "run_settled", { run }));
			}
			const runs = store.readSession("session").runs;
			expect(runs).toHaveLength(2);
			expect(runs.every(run => run.status === "measured")).toBe(true);
			const file = readFileSync(join(dir, readdirSync(dir).find(name => name.endsWith(".jsonl"))!), "utf8");
			expect(file).not.toContain(interruptedId);
			expect(file.split("\n").filter(Boolean)).toHaveLength(4);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("degrades without throwing or repeatedly notifying on persistence failures", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-store-"));
		try {
			const blocker = join(dir, "not-a-directory");
			writeFileSync(blocker, "file");
			let warnings = 0;
			const store = new TraceStore(join(blocker, "traces"), { onDegraded: () => { warnings += 1; } });
			const item = record("session", randomUUID(), 1, "run_start");
			expect(store.append(item)).toBe(false);
			expect(store.append(item)).toBe(false);
			expect(warnings).toBe(1);
			expect(store.getStatus()).toMatchObject({ state: "degraded" });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});
