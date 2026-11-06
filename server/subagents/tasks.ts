import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UiSubagentEvent, UiSubagentProgress, UiSubagentTaskDetail } from "../protocol.js";
import { subagentProgressDetails } from "../subagent-presentation.js";
import type { SubagentResult } from "./runner.js";

interface RecordData {
	sessionId: string; toolCallId: string; turnId: string;
	task: UiSubagentProgress; events: UiSubagentEvent[]; truncated: boolean; resultText?: string;
}
const terminal = (phase: UiSubagentProgress["phase"]) => ["completed", "failed", "cancelled"].includes(phase);
const directory = () => join(process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi-web"), "subagent-tasks");
const sessionDirectory = (sessionId: string) => join(directory(), createHash("sha256").update(sessionId).digest("hex"));
const file = (id: string, sessionId: string) => {
	if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid subagent task ID");
	return join(sessionDirectory(sessionId), `${id}.json`);
};
const active = new Map<string, TaskRecord>();
const recovered = new Map<string, { toolCallId: string; task: UiSubagentProgress }[]>();
export async function recoverTaskSummaries(sessionId: string): Promise<void> {
	if (recovered.has(sessionId)) return;
	const summaries: { toolCallId: string; task: UiSubagentProgress }[] = [];
	let files: string[];
	try { files = await readdir(sessionDirectory(sessionId)); } catch { recovered.set(sessionId, []); return; }
	for (const name of files.filter(name => name.endsWith(".summary.json"))) {
		try {
			const value = JSON.parse(await readFile(join(sessionDirectory(sessionId), name), "utf8")) as { toolCallId: string; task: UiSubagentProgress };
			if (!active.has(value.task.taskId ?? "")) summaries.push(terminal(value.task.phase) ? value : { ...value, task: { ...value.task, phase: "failed", tool: undefined } });
		} catch { /* A damaged record must not prevent opening the parent session. */ }
	}
	recovered.set(sessionId, summaries);
}
export function taskSummaries(sessionId: string, calls: ReadonlySet<string>, finishedCalls: ReadonlySet<string> = new Set()): { toolCallId: string; tasks: UiSubagentProgress[] }[] {
	const entries = [...(recovered.get(sessionId) ?? []), ...[...active.values()].filter(record => record.data.sessionId === sessionId).map(record => ({ toolCallId: record.data.toolCallId, task: record.data.task }))];
	const grouped = new Map<string, UiSubagentProgress[]>();
	for (const row of entries) if (calls.has(row.toolCallId) && !finishedCalls.has(row.toolCallId)) grouped.set(row.toolCallId, [...(grouped.get(row.toolCallId) ?? []), row.task]);
	return [...grouped].map(([toolCallId, tasks]) => ({ toolCallId, tasks: subagentProgressDetails({ subagents: tasks.sort((a, b) => (a.taskIndex ?? 0) - (b.taskIndex ?? 0)) }) ?? [] }));
}

/** A bounded journal. File writes are serialized and atomic; no model reasoning is recorded. */
export class TaskRecord {
	readonly controller = new AbortController();
	readonly id = randomUUID();
	private queue = Promise.resolve();
	private bytes = 0;
	private nextSeq = 0;
	private storageError?: Error;
	readonly data: RecordData;
	constructor(sessionId: string, toolCallId: string, turnId: string, task: UiSubagentProgress, private notify: (task: UiSubagentProgress) => void) {
		this.data = { sessionId, toolCallId, turnId, task: { ...task, taskId: this.id }, events: [], truncated: false };
		active.set(this.id, this);
		this.save();
	}
	private save() {
		let json = JSON.stringify(this.data);
		while (Buffer.byteLength(json) > 2 * 1024 * 1024 && this.data.events.length) {
			const removed = this.data.events.pop()!;
			this.bytes = Math.max(0, this.bytes - Buffer.byteLength(JSON.stringify(removed)));
			this.data.truncated = true;
			json = JSON.stringify(this.data);
		}
		if (Buffer.byteLength(json) > 2 * 1024 * 1024) { this.storageError = Error("Subagent execution metadata exceeded its storage limit"); return; }
		const path = file(this.id, this.data.sessionId);
		this.queue = this.queue.then(async () => {
			await mkdir(sessionDirectory(this.data.sessionId), { recursive: true, mode: 0o700 });
			await writeFile(`${path}.tmp`, json, { mode: 0o600 });
			await rename(`${path}.tmp`, path);
			await writeFile(`${path}.summary.json.tmp`, JSON.stringify({ toolCallId: this.data.toolCallId, task: JSON.parse(json).task }), { mode: 0o600 });
			await rename(`${path}.summary.json.tmp`, `${path}.summary.json`);
		}).catch(error => { this.storageError = error instanceof Error ? error : Error(String(error)); });
	}
	update(patch: Partial<UiSubagentProgress>) {
		if (terminal(this.data.task.phase) && patch.phase && !terminal(patch.phase)) return;
		// A pending stop must not regress to running when the SDK drains an event.
		if (this.data.task.phase === "stopping" && patch.phase === "running") patch = { ...patch, phase: "stopping" };
		this.data.task = { ...this.data.task, ...patch };
		this.save(); this.notify(this.data.task);
	}
	event(event: Omit<UiSubagentEvent, "seq" | "at">) {
		const buffer = Buffer.from(event.text);
		const cut = buffer.length > 24 * 1024;
		const text = cut ? buffer.subarray(0, 24 * 1024 - 100).toString("utf8") + "\n[Output truncated]" : event.text;
		const row = { ...event, text, ...(cut ? { truncated: true } : {}), seq: this.nextSeq++, at: Date.now() };
		const size = Buffer.byteLength(JSON.stringify(row));
		if (this.bytes + size > 1536 * 1024 || this.data.events.length >= 128) this.data.truncated = true;
		else { this.data.events.push(row); this.bytes += size; }
		this.save();
	}
	stop() {
		if (terminal(this.data.task.phase)) return;
		this.update({ phase: this.data.task.phase === "queued" ? "cancelled" : "stopping" });
		this.controller.abort(new Error("Subagent stopped by user"));
	}
	async finish(result: SubagentResult) {
		this.data.resultText = JSON.stringify(result);
		this.update({ phase: result.status, steps: result.steps, durationMs: result.durationMs, tool: undefined });
		await this.queue;
		active.delete(this.id);
		recovered.set(this.data.sessionId, [...(recovered.get(this.data.sessionId) ?? []).filter(row => row.task.taskId !== this.id), { toolCallId: this.data.toolCallId, task: this.data.task }]);
		if (this.storageError) throw this.storageError;
	}
}

export async function taskDetail(sessionId: string, taskId: string, allowedCalls: ReadonlySet<string>, cursor = 0, stop = false, ancestor = false): Promise<UiSubagentTaskDetail> {
	if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error("Invalid subagent detail cursor");
	file(taskId, sessionId);
	const running = active.get(taskId);
	const data: RecordData = running?.data ?? JSON.parse(await readFile(file(taskId, sessionId), "utf8"));
	if (data.sessionId !== sessionId || !allowedCalls.has(data.toolCallId)) throw Error("Subagent task does not belong to this session branch");
	if (data.task.taskId !== taskId) throw Error("Subagent task identity mismatch");
	if (ancestor && (running || !terminal(data.task.phase))) throw Error("Ancestor subagent record is not terminal");
	if (stop) running?.stop();
	if (!running && !terminal(data.task.phase)) {
		data.task = { ...data.task, phase: "failed", tool: undefined, steps: data.task.steps?.map(step => step.status === "running" ? { ...step, status: "failed" } : step) };
		data.resultText = JSON.stringify({ ...data.task, status: "failed", text: "Subagent interrupted by service restart", truncated: false, evidenceStatus: "unverified" });
		const temporary = `${file(taskId, sessionId)}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
		await rename(temporary, file(taskId, sessionId));
	}
	const found = data.events.findIndex(event => event.seq >= cursor);
	const start = found < 0 ? data.events.length : found;
	const end = Math.min(start + 50, data.events.length);
	return { task: data.task, events: data.events.slice(start, end), ...(end < data.events.length ? { nextCursor: data.events[end].seq } : {}), truncated: data.truncated, resultText: data.resultText };
}
