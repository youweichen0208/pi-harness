import { readFile, realpath } from "node:fs/promises";
import { SessionManager, parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { taskDetail } from "./tasks.js";

/** Exact persisted task/call pair, including history hidden by compaction. */
function taskCall(entries: SessionEntry[], taskId: string): string | undefined {
	const calls = new Set<string>();
	const matches = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") for (const block of message.content) {
			if (block.type === "toolCall" && block.name === "subagent") calls.add(block.id);
		}
		if (message.role !== "toolResult" || message.toolName !== "subagent" || !calls.has(message.toolCallId)) continue;
		const details = message.details as { subagents?: { taskId?: string; status?: string }[] } | undefined;
		if (Array.isArray(details?.subagents) && details.subagents.some(task => task.taskId === taskId && ["completed", "failed", "cancelled"].includes(task.status ?? ""))) matches.add(message.toolCallId);
	}
	return matches.size === 1 ? [...matches][0] : undefined;
}

/** Ancestors are opened in memory only: never migrate, initialize or repair their files. */
export async function inheritedTaskDetail(manager: SessionManager, taskId: string, cursor = 0) {
	const call = taskCall(manager.getBranch(), taskId);
	if (!call) throw Error("Subagent task is not a terminal task on this session branch");
	const seenIds = new Set([manager.getSessionId()]), seenPaths = new Set<string>();
	let parent = manager.getHeader()?.parentSession;
	for (let depth = 0; parent && depth < 32; depth++) {
		const path = await realpath(parent);
		if (seenPaths.has(path)) throw Error("Subagent ancestor cycle");
		seenPaths.add(path);
		const entries = parseSessionEntries(await readFile(path, "utf8"));
		const header = entries.find(entry => entry.type === "session");
		if (!header || seenIds.has(header.id)) throw Error("Invalid subagent ancestor identity");
		seenIds.add(header.id);
		const ancestor = SessionManager.inMemory(header.cwd, undefined, entries);
		// The ancestor may now be on another branch; validate the original result's own path.
		const matching = ancestor.getEntries().some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === call && taskCall(ancestor.getBranch(entry.id), taskId) === call);
		if (!matching) throw Error("Subagent task does not belong to this ancestor branch");
		try {
			return await taskDetail(header.id, taskId, new Set([call]), cursor, false, true);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		parent = header.parentSession;
	}
	throw Error("Subagent execution details are unavailable (missing record or ancestry limit)");
}
