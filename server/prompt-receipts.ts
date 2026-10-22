import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./private-file.js";
import type { PromptResult } from "./protocol.js";

type PromptTarget = { cwd: string; conversationId: string; sessionId: string };
type RecordEntry = { target?: PromptTarget; client: string; id: string; digest: string; created: number; updated: number; expired?: boolean; result?: PromptResult };
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}
const RETENTION = 7 * 24 * 60 * 60 * 1000;
/** Durable admission ledger. No prompt bodies; expired IDs remain tombstones so
 * retention never grants permission to execute the same request again. */
export class PromptReceipts {
	private records = new Map<string, RecordEntry>();
	private active = new Set<string>();
	private failure: Error | undefined;
	private path: string;
	constructor(dataDir: string, private now = Date.now, private limit = 10000) {
		this.path = join(dataDir, "prompt-receipts.json");
		try {
			const data = JSON.parse(readFileSync(this.path, "utf8"));
			if (data.version !== 1 || !Array.isArray(data.records)) throw new Error("Invalid receipt store");
			for (const r of data.records) {
				if (typeof r.client !== "string" || typeof r.id !== "string" || !/^[a-f0-9]{64}$/.test(r.digest) || !Number.isFinite(r.created) || !Number.isFinite(r.updated) || (r.result && (r.result.type !== "prompt_result" || r.result.requestId !== r.id || typeof r.result.ok !== "boolean" || !["accepted", "rejected", "unknown"].includes(r.result.receipt) || (r.result.ok !== (r.result.receipt === "accepted"))))) throw new Error("Invalid receipt record");
				const key = this.key(r.client, r.id);
				if (this.records.has(key)) throw new Error("Duplicate receipt record");
				this.records.set(key, r);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.failure = error as Error;
		}
	}
	private key(client: string, id: string) { return JSON.stringify([client, id]); }
	private save() {
		if (this.failure) throw this.failure;
		for (const record of this.records.values()) {
			if (record.result && this.now() - record.updated > RETENTION) { delete record.result; record.expired = true; }
		}
		try { writeFileAtomic(this.path, JSON.stringify({ version: 1, records: [...this.records.values()] })); }
		catch (error) { this.failure = error as Error; throw error; }
	}
	query(client: string, id: string): PromptResult {
		if (typeof id !== "string" || !id || id.length > 200) throw new Error("Invalid prompt request ID");
		const record = this.records.get(this.key(client, id));
		if (this.failure) return { type: "prompt_result", requestId: id, ok: false, receipt: "unknown" };
		if (!record) return { type: "prompt_result", requestId: id, ok: false, receipt: "missing" };
		if (record.expired || (record.result && this.now() - record.updated > RETENTION)) return { type: "prompt_result", requestId: id, ok: false, receipt: "expired" };
		return record.result ?? { type: "prompt_result", requestId: id, conversationId: record.target?.conversationId, sessionId: record.target?.sessionId, ok: false, receipt: this.active.has(this.key(client, id)) ? "processing" : "unknown" };
	}
	/** Synchronous claim precedes ALL application side effects. */
	begin(client: string, id: string, payload: unknown, target?: PromptTarget): PromptResult | null {
		if (this.failure) throw new Error("Prompt receipt storage unavailable", { cause: this.failure });
		if (typeof id !== "string" || !id || id.length > 200) throw new Error("Invalid prompt request ID");
		const key = this.key(client, id);
		const digest = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
		const old = this.records.get(key);
		if (old) {
			if (old.digest !== digest) return { type: "prompt_result", requestId: id, ok: false, receipt: "conflict" };
			return this.query(client, id);
		}
		if (this.records.size >= this.limit) throw new Error("Prompt receipt storage capacity reached");
		const now = this.now();
		this.records.set(key, { client, id, digest, target, created: now, updated: now });
		this.save();
		this.active.add(key);
		return null;
	}
	finish(client: string, result: PromptResult): PromptResult {
		const key = this.key(client, result.requestId);
		const record = this.records.get(key);
		if (!record) throw new Error("Missing prompt claim");
		const settled = { ...result, receipt: result.receipt ?? (result.ok ? "accepted" : "rejected") } satisfies PromptResult;
		record.result = settled; record.updated = this.now();
		this.active.delete(key);
		try { this.save(); return settled; }
		catch { return { type: "prompt_result", requestId: result.requestId, ok: false, receipt: "unknown" }; }
	}
}

const stores = new Map<string, PromptReceipts>();
/** Shared by all clients and transports using this server data directory. */
export function promptReceiptsFor(dataDir: string) {
	let store = stores.get(dataDir);
	if (!store) { store = new PromptReceipts(dataDir); stores.set(dataDir, store); }
	return store;
}
