import { randomUUID } from "node:crypto";
import type { UiMessage, UiOmpTask } from "../protocol.js";
import { isRecord } from "./framing.js";
import { projectMessage } from "./presentation.js";
import type { OmpTaskOutputPath } from "./tool-output.js";

const active = (status: UiOmpTask["status"]) => status === "pending" || status === "running";
const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const statuses = new Set(["pending", "running", "completed", "failed", "aborted"]);
type RecordEntry = { nativeId: string; generation: string; view: UiOmpTask; children: Set<string>; terminal: boolean; historyHandle?: string; historical?: boolean };
function calls(messages: UiMessage[]): string[] { return messages.flatMap(message => message.content.flatMap(block => block.type === "toolCall" && typeof block.id === "string" ? [block.id] : [])); }

/** A projection of native lifecycle events, retained while this product session lives. */
export class OmpTasks {
	private records = new Map<string, RecordEntry>();
	private current = new Map<string, string>();
	restore(rows: unknown[], generation: string) {
		const retained = new Set<string>();
		for (const row of rows) {
			if (!isRecord(row) || typeof row.nativeId !== "string" || typeof row.parentToolCallId !== "string" || typeof row.historyHandle !== "string") continue;
			const key = `${generation}:${row.nativeId}`;
			let record = this.records.get(this.current.get(key) ?? "");
			if (record && record.view.parentToolCallId !== row.parentToolCallId) continue;
			if (!record) {
				const id = randomUUID();
				record = { nativeId: row.nativeId, generation, historical: true, terminal: true, children: new Set(), view: { id, parentToolCallId: row.parentToolCallId, agent: text(row.agent, 100) ?? "task", title: text(row.title, 300) ?? row.nativeId, status: "interrupted", canStop: false } };
				this.records.set(id, record); this.current.set(key, id);
			}
			record.historyHandle = row.historyHandle;
			retained.add(record.view.id);
			if (Array.isArray(row.children)) for (const id of row.children) if (typeof id === "string") record.children.add(id);
			if (!record.historical) continue;
			record.view.status = row.status === "completed" || row.status === "failed" || row.status === "aborted" ? row.status : "interrupted";
			record.view.task = text(row.task, 12000);
			for (const field of ["durationMs", "tokens", "cost"] as const) record.view[field] = number(row[field]);
		}
		for (const [id, record] of this.records) if (record.generation !== generation || record.historical && !retained.has(id)) {
			this.records.delete(id);
			const key = `${record.generation}:${record.nativeId}`;
			if (this.current.get(key) === id) this.current.delete(key);
		}
	}
	observe(frame: Record<string, unknown>, generation: string): boolean {
		if (!isRecord(frame.payload)) return false;
		const payload = frame.payload;
		if (frame.type === "subagent_event" && typeof payload.id === "string" && isRecord(payload.event)) {
			const record = this.records.get(this.current.get(`${generation}:${payload.id}`) ?? "");
			const event = payload.event;
			if (!record) return false;
			if (typeof event.toolCallId === "string") record.children.add(event.toolCallId);
			const message = projectMessage(event.message, 0);
			if (message) for (const id of calls([message])) record.children.add(id);
			return true;
		}
		if (frame.type !== "subagent_lifecycle" && frame.type !== "subagent_progress") return false;
		const progress = isRecord(payload.progress) ? payload.progress : payload;
		const nativeId = typeof progress.id === "string" && progress.id.length <= 500 ? progress.id : undefined;
		const owner = typeof payload.parentToolCallId === "string" && payload.parentToolCallId.length <= 500 ? payload.parentToolCallId : undefined;
		if (!nativeId) return false;
		const key = `${generation}:${nativeId}`;
		let record = this.records.get(this.current.get(key) ?? "");
		if (record && owner && record.view.parentToolCallId !== owner) {
			if (frame.type !== "subagent_lifecycle" || payload.status !== "started") return false;
			if (active(record.view.status)) record.view.status = "interrupted";
			record.view.canStop = false; this.current.delete(key); record = undefined;
		}
		if (!record) {
			if (!owner) return false;
			const id = randomUUID();
			record = { nativeId, generation, children: new Set(), terminal: false, view: { id, parentToolCallId: owner, agent: text(payload.agent, 100) ?? "task", title: text(payload.description, 300) ?? text(payload.agent, 100) ?? "task", status: "pending", canStop: false } };
			this.records.set(id, record); this.current.set(key, id);
		}
		if (record.historical) { record.historical = false; record.terminal = false; }
		const value = progress.status === "started" ? "running" : progress.status;
		if (typeof value === "string" && statuses.has(value)) {
			// Late progress must not undo the terminal lifecycle status.
			if (frame.type === "subagent_lifecycle" || !record.terminal && (active(record.view.status) || !active(value as UiOmpTask["status"]))) record.view.status = value as UiOmpTask["status"];
			if (frame.type === "subagent_lifecycle" && !active(record.view.status)) record.terminal = true;
		}
		record.view.title = text(progress.description, 300) ?? record.view.title;
		record.view.task = text(payload.task ?? progress.task, 12000) ?? record.view.task;
		record.view.currentTool = active(record.view.status) ? text(progress.currentTool, 100) : undefined;
		for (const field of ["durationMs", "tokens", "cost"] as const) { const value = number(progress[field]); if (value !== undefined) record.view[field] = Math.max(value, record.view[field] ?? 0); }
		record.view.canStop = active(record.view.status);
		return true;
	}
	visible(messages: UiMessage[], streaming?: UiMessage): UiOmpTask[] {
		const owners = new Set(calls(streaming ? [...messages, streaming] : messages));
		const visible = new Map<string, UiOmpTask>();
		for (let pass = 0; pass < this.records.size; pass++) {
			let added = false;
			for (const record of this.records.values()) if (!visible.has(record.view.id) && owners.has(record.view.parentToolCallId)) {
				visible.set(record.view.id, { ...record.view });
				for (const id of record.children) owners.add(id);
				added = true;
			}
			if (!added) break;
		}
		return [...visible.values()];
	}
	resolve(id: string, generation: string | undefined, messages: UiMessage[], streaming?: UiMessage): RecordEntry {
		const record = this.records.get(id);
		if (!record || record.generation !== generation || this.current.get(`${generation}:${record.nativeId}`) !== id || !this.visible(messages, streaming).some(task => task.id === id)) throw Error("Task unavailable in this conversation branch");
		return record;
	}
	/** Read-only output ownership survives Stop, but never a different branch or replaced task. */
	outputPath(id: string, messages: UiMessage[], streaming?: UiMessage): OmpTaskOutputPath {
		const visible = new Set(this.visible(messages, streaming).map(task => task.id));
		const roots = new Set(calls(streaming ? [...messages, streaming] : messages));
		let record = this.records.get(id);
		const path: OmpTaskOutputPath = [], seen = new Set<string>();
		while (record) {
			if (!visible.has(record.view.id) || this.current.get(`${record.generation}:${record.nativeId}`) !== record.view.id || seen.has(record.view.id) || path.length >= 32) throw Error("Task output unavailable in this branch");
			seen.add(record.view.id);
			path.unshift({ nativeId: record.nativeId, parentToolCallId: record.view.parentToolCallId });
			if (roots.has(record.view.parentToolCallId)) return path;
			const parents = [...this.records.values()].filter(parent => visible.has(parent.view.id) && parent.children.has(record!.view.parentToolCallId));
			if (parents.length !== 1) break;
			record = parents[0];
		}
		throw Error("Task output unavailable in this branch");
	}
	interrupt() {
		for (const record of this.records.values()) {
			if (active(record.view.status)) record.view.status = "interrupted";
			record.terminal = true;
			record.view.canStop = false;
		}
	}
}

/** Native transcript stays intact; browser pages have an explicit display budget. */
export function taskMessagePage(messages: unknown[], cursor: number) {
	const projected: UiMessage[] = [];
	let nextCursor = cursor, bytes = 0, truncated = false;
	while (nextCursor < messages.length && projected.length < 30) {
		const source = projectMessage(messages[nextCursor], nextCursor);
		if (!source) { nextCursor++; continue; }
		const message: UiMessage = { id: source.id.slice(0, 1000), role: source.role, content: [], timestamp: source.timestamp,
			toolCallId: source.toolCallId && source.toolCallId.length <= 2000 ? source.toolCallId : undefined, toolName: source.toolName?.slice(0, 100), isError: source.isError };
		let remaining = 16000;
		for (const block of source.content) {
			if (remaining <= 0 || block.type === "image") { truncated = true; continue; }
			if (block.type === "text" && typeof block.text === "string") {
				message.content.push({ type: "text", text: block.text.slice(0, remaining), truncated: block.text.length > remaining || block.truncated === true }); remaining -= block.text.length + 64;
			} else if (block.type === "thinking" && typeof block.thinking === "string") {
				truncated ||= block.thinking.length > remaining; message.content.push({ type: "thinking", thinking: block.thinking.slice(0, remaining) }); remaining -= block.thinking.length + 64;
			} else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
				const args = typeof block.argumentsText === "string" ? block.argumentsText : "";
				message.content.push({ type: "toolCall", id: block.id.slice(0, 500), name: block.name.slice(0, 100), argumentsText: args.slice(0, remaining), argumentsTruncated: args.length > remaining || block.argumentsTruncated === true }); remaining -= args.length + Math.min(block.id.length, 500) + Math.min(block.name.length, 100) + 64;
			}
		}
		const size = Buffer.byteLength(JSON.stringify(message));
		if (bytes + size > 1024 * 1024 && projected.length) break;
		bytes += size; projected.push(message); nextCursor++;
		truncated ||= message.content.some(block => block.type === "text" && !!block.truncated || block.type === "toolCall" && !!block.argumentsTruncated);
	}
	return { messages: projected, nextCursor, hasMore: nextCursor < messages.length, truncated };
}
