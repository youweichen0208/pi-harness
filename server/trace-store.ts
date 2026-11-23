import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TraceStoreRecord {
	schemaVersion: 1;
	sessionId: string;
	runId: string;
	seq: number;
	type: "run_start" | "provider_request" | "tool_end" | "background_command" | "run_settled";
	recordedAt: string;
	payload: Record<string, unknown>;
}

export interface TraceStoreStatus {
	state: "ready" | "degraded";
	error?: string;
	appendAttempts?: number;
	appendedRecords?: number;
	compactions?: number;
	prunedFiles?: number;
}

interface TraceStoreOptions {
	maxFileBytes?: number;
	maxTotalBytes?: number;
	maxRuns?: number;
	onDegraded?: (error: string) => void;
}

export class TraceStore {
	readonly directory: string;
	private readonly maxFileBytes: number;
	private readonly maxTotalBytes: number;
	private readonly maxRuns: number;
	private readonly onDegraded?: (error: string) => void;
	private status: TraceStoreStatus = { state: "ready" };
	private appendAttempts = 0;
	private appendedRecords = 0;
	private compactions = 0;
	private prunedFiles = 0;

	constructor(directory: string, options: TraceStoreOptions = {}) {
		this.directory = directory;
		this.maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
		this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
		this.maxRuns = options.maxRuns ?? 50;
		this.onDegraded = options.onDegraded;
	}

	getStatus(): TraceStoreStatus {
		return { ...this.status, appendAttempts: this.appendAttempts, appendedRecords: this.appendedRecords, compactions: this.compactions, prunedFiles: this.prunedFiles };
	}

	append(record: TraceStoreRecord): boolean {
		this.appendAttempts += 1;
		try {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			appendFileSync(this.file(record.sessionId), JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
			this.appendedRecords += 1;
			this.status = { ...this.status, state: "ready" };
			this.compactIfNeeded(record.sessionId);
			this.pruneTotal(record.sessionId);
			return true;
		} catch (error) {
			this.degrade(error);
			return false;
		}
	}

	readSession(sessionId: string): { runs: Record<string, unknown>[]; status: TraceStoreStatus } {
		try {
			const file = this.file(sessionId);
			if (!existsSync(file)) return { runs: [], status: this.getStatus() };
			const text = readFileSync(file, "utf8");
			const lines = text.split("\n");
			const records: TraceStoreRecord[] = [];
			let trailingWrite = false;
			for (let index = 0; index < lines.length; index++) {
				const line = lines[index];
				if (!line) continue;
				try {
					records.push(JSON.parse(line) as TraceStoreRecord);
				} catch (error) {
					if (index === lines.length - 1 || lines.slice(index + 1).every(value => !value)) {
						trailingWrite = true;
						break;
					}
					this.quarantine(file);
					throw error;
				}
			}
			return { runs: this.project(records, trailingWrite), status: this.getStatus() };
		} catch (error) {
			this.degrade(error);
			return { runs: [], status: this.getStatus() };
		}
	}

	private file(sessionId: string): string {
		return join(this.directory, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.jsonl`);
	}

	private project(records: TraceStoreRecord[], trailingWrite: boolean, recoverOpen = true): Record<string, unknown>[] {
		const runs = new Map<string, Record<string, unknown>>();
		const sequences = new Map<string, number>();
		const incomplete = new Set<string>();
		for (const record of records) {
			if (record.schemaVersion !== 1 || !record.runId || !Number.isInteger(record.seq)) continue;
			const previous = sequences.get(record.runId) ?? 0;
			if (record.seq <= previous) continue;
			if (record.seq !== previous + 1) incomplete.add(record.runId);
			sequences.set(record.runId, record.seq);
			if (record.type === "run_start") {
				const metadata = (record.payload.run ?? {}) as Record<string, unknown>;
				runs.set(record.runId, { ...metadata, runId: record.runId, sessionId: record.sessionId, status: "open", requests: [], tools: [], hostSpans: [] });
			} else if (record.type === "provider_request") {
				const run = runs.get(record.runId);
				const request = record.payload.request as { requestId?: string } | undefined;
				if (run && request?.requestId) {
					const requests = run.requests as Record<string, unknown>[];
					const index = requests.findIndex(value => value.requestId === request.requestId);
					if (index >= 0) requests[index] = request as Record<string, unknown>;
					else requests.push(request as Record<string, unknown>);
				}
			} else if (record.type === "background_command") {
				const run = runs.get(record.runId);
				if (run) run.backgroundSpans = record.payload.backgroundSpans;
			} else if (record.type === "tool_end") {
				const run = runs.get(record.runId);
				const tool = record.payload.tool as { toolCallId?: string } | undefined;
				if (run && tool?.toolCallId) (run.tools as Record<string, unknown>[]).push(tool as Record<string, unknown>);
			} else if (record.type === "run_settled") {
				const settled = record.payload.run as Record<string, unknown> | undefined;
				if (settled) runs.set(record.runId, settled);
			}
		}
		for (const [runId, run] of runs) {
			if (recoverOpen && Array.isArray(run.backgroundSpans)) {
				for (const span of run.backgroundSpans) if (span.state === "background") span.state = "interrupted";
			}
			if (run.status !== "open" || !recoverOpen) continue;
			run.status = "interrupted";
			run.interrupted = true;
			run.recoveredTrailingWrite = trailingWrite;
			if (incomplete.has(runId)) run.incomplete = true;
			run.aggregates = {
				agent_active_wall_ms: { value: null, status: "unmeasured", reason: "run_interrupted" },
				model_wall_union_ms: { value: null, status: "unmeasured", reason: "run_interrupted" },
				tool_wall_union_ms: { value: null, status: "unmeasured", reason: "run_interrupted" },
				host_wall_union_ms: { value: null, status: "unmeasured", reason: "run_interrupted" },
				unclassified_wall_ms: { value: null, status: "unmeasured", reason: "run_interrupted" },
			};
		}
		return [...runs.values()].slice(-this.maxRuns);
	}

	private compactIfNeeded(sessionId: string): void {
		const file = this.file(sessionId);
		if (statSync(file).size <= this.maxFileBytes) return;
		const records = readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceStoreRecord);
		const projected = this.project(records, false, false);
		if (projected.some(run => run.status === "open")) return;
		const compacted: TraceStoreRecord[] = [];
		for (const run of projected.slice(-this.maxRuns)) {
			const runId = String(run.runId);
			const session = String(run.sessionId ?? sessionId);
			const recordedAt = new Date().toISOString();
			compacted.push({ schemaVersion: 1, sessionId: session, runId, seq: 1, type: "run_start", recordedAt, payload: { run: { runId, sessionId: session } } });
			compacted.push({ schemaVersion: 1, sessionId: session, runId, seq: 2, type: "run_settled", recordedAt, payload: { run } });
		}
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, compacted.map(record => JSON.stringify(record)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, file);
		this.compactions += 1;
	}

	private pruneTotal(protectedSessionId: string): void {
		const protectedFile = this.file(protectedSessionId);
		const files = readdirSync(this.directory).filter(name => name.endsWith(".jsonl")).map(name => {
			const path = join(this.directory, name);
			const stat = statSync(path);
			return { path, bytes: stat.size, mtimeMs: stat.mtimeMs };
		}).sort((a, b) => a.mtimeMs - b.mtimeMs);
		let total = files.reduce((sum, file) => sum + file.bytes, 0);
		for (const file of files) {
			if (total <= this.maxTotalBytes) break;
			if (file.path === protectedFile) continue;
			rmSync(file.path, { force: true });
			this.prunedFiles += 1;
			total -= file.bytes;
		}
	}

	private quarantine(file: string): void {
		try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* Preserve the original if quarantine fails. */ }
	}

	private degrade(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const changed = this.status.state !== "degraded";
		this.status = { ...this.status, state: "degraded", error: message };
		if (changed) this.onDegraded?.(message);
	}
}
