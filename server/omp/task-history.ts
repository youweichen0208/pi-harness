/** Bun worker: read native transcripts without opening sessions or reviving agents. */
import { loadSessionFile, loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionEntryIndex } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { migrateToCurrentVersion } from "@oh-my-pi/pi-coding-agent/session/session-migrations";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRecord } from "./framing.js";
import { taskMessagePage } from "./tasks.js";
import { nativeEntryMessage } from "./native-messages.js";
import type { UiOmpTask } from "../protocol.js";

type HistoricalTask = Omit<UiOmpTask, "id" | "canStop"> & { nativeId: string; historyHandle: string; children: string[] };
type SavedTask = { row: HistoricalTask; file: string };
type TaskTranscript = { messages: unknown[]; tasks: HistoricalTask[]; children: string[] };
const safeId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 500 && id !== "." && id !== ".." && !/[\\/\0:]/.test(id);
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const short = (value: unknown, length: number) => typeof value === "string" ? value.slice(0, length) : undefined;
const toolCalls = (messages: unknown[]) => messages.flatMap(message => isRecord(message) && message.role === "assistant" && Array.isArray(message.content) ? message.content.flatMap(block => isRecord(block) && block.type === "toolCall" && typeof block.id === "string" ? [block.id] : []) : []);

function declaredTasks(messages: unknown[]): HistoricalTask[] {
	const calls = new Set(toolCalls(messages));
	const tasks = new Map<string, HistoricalTask>();
	for (const message of messages) {
		if (!isRecord(message) || !isRecord(message.details)) continue;
		if (message.role === "toolResult" && message.toolName === "task" && typeof message.toolCallId === "string" && calls.has(message.toolCallId)) {
			for (const value of [...(Array.isArray(message.details.progress) ? message.details.progress : []), ...(Array.isArray(message.details.results) ? message.details.results : [])]) {
				if (!isRecord(value) || !safeId(value.id)) continue;
				const status = value.aborted === true || value.status === "aborted" ? "aborted" : value.status === "completed" || value.exitCode === 0 ? "completed" : value.status === "failed" || typeof value.exitCode === "number" ? "failed" : "interrupted";
				// Initial async progress contains zero counters, not the final usage.
				const settled = status !== "interrupted";
				tasks.set(value.id, { nativeId: value.id, historyHandle: "", parentToolCallId: message.toolCallId, agent: short(value.agent, 100) ?? "task", title: short(value.description, 300) ?? value.id, task: short(value.task, 12000), status, tokens: settled ? finite(value.tokens) : undefined, durationMs: settled ? finite(value.durationMs) : undefined, cost: settled ? finite(value.cost) : undefined, children: [] });
			}
		} else if (message.role === "custom" && message.customType === "async-result" && Array.isArray(message.details.jobs)) {
			for (const job of message.details.jobs) {
				if (!isRecord(job) || job.type !== "task" || typeof job.agentId !== "string") continue;
				const task = tasks.get(job.agentId);
				if (!task) continue;
				if (job.status === "completed") task.status = "completed";
				else if (job.status === "failed") task.status = "failed";
				else if (job.status === "cancelled" || job.status === "aborted") task.status = "aborted";
				task.durationMs = finite(job.durationMs) ?? task.durationMs;
			}
		}
	}
	return [...tasks.values()];
}

export class OmpTaskHistory {
	private saved = new Map<string, SavedTask>();
	private cache = new Map<string, { stamp: string; transcript: TaskTranscript }>();
	private async read(file: string): Promise<TaskTranscript> {
		// Generated native artifact names only. Never follow a transcript/directory symlink.
		if (await realpath(file) !== resolve(file)) throw Error("Task transcript path changed");
		const before = await stat(file);
		if (!before.isFile()) throw Error("Invalid task transcript");
		const stamp = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
		const cached = this.cache.get(file);
		if (cached?.stamp === stamp) return cached.transcript;
		// The native display transcript collapses compaction. Task ownership must
		// instead follow the complete persisted branch, including earlier Task calls.
		const loaded = await loadSessionFile(file, undefined, { throwIfMissing: true });
		if (loaded.invalidHeader || loaded.malformedRecords || loaded.entries[0]?.type !== "session") throw Error("Invalid task transcript");
		migrateToCurrentVersion(loaded.entries);
		const entries = loaded.entries.filter(entry => entry.type !== "session");
		if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw Error("Duplicate task history entry");
		const index = new SessionEntryIndex(); index.rebuild(entries);
		const branch = index.pathTo(index.leafEntry()?.id ?? null).flatMap(entry => {
			const message = nativeEntryMessage(entry); return message ? [message] : [];
		});
		const messages = await loadSessionMessagesReadOnly(file);
		const after = await stat(file);
		if (stamp !== `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` || await realpath(file) !== resolve(file)) throw Error("Task transcript changed while reading");
		const transcript = { messages, tasks: declaredTasks(branch), children: toolCalls(branch) };
		this.cache.set(file, { stamp, transcript });
		return transcript;
	}
	async scan(sessionFile: string | undefined, messages: unknown[]) {
		const next = new Map<string, SavedTask>();
		const previous = new Map([...this.saved].map(([handle, saved]) => [`${saved.file}:${saved.row.parentToolCallId}`, handle]));
		const pending = sessionFile?.endsWith(".jsonl") ? [{ file: sessionFile, tasks: declaredTasks(messages) }] : [];
		const seen = new Set<string>();
		while (pending.length) {
			const parent = pending.shift()!;
			for (const cachedRow of parent.tasks) {
				const row: HistoricalTask = { ...cachedRow, children: [] };
				const file = join(parent.file.slice(0, -6), `${row.nativeId}.jsonl`);
				if (seen.has(file)) continue;
				seen.add(file);
				row.historyHandle = previous.get(`${file}:${row.parentToolCallId}`) ?? randomUUID();
				next.set(row.historyHandle, { row, file });
				try {
					const child = await this.read(file);
					row.children = child.children;
					const last = child.messages.findLast(message => isRecord(message) && message.role === "assistant");
					if (isRecord(last)) {
						if (last.stopReason === "aborted") row.status = "aborted";
						else if (last.stopReason === "error" || last.stopReason === "length") row.status = "failed";
					}
					pending.push({ file, tasks: child.tasks });
				} catch { /* Missing/unreadable artifacts retain the task outcome; detail reports an error. */ }
			}
		}
		this.saved = next;
		for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file);
		return [...next.values()].map(saved => saved.row);
	}
	async page(handle: unknown, cursor: unknown) {
		if (typeof handle !== "string" || typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) throw Error("Invalid task history request");
		const saved = this.saved.get(handle);
		if (!saved) throw Error("Task unavailable in this branch");
		const { messages } = await this.read(saved.file);
		if (cursor > messages.length) throw Error("Task transcript changed; reload its first page");
		return taskMessagePage(messages, cursor);
	}
}
