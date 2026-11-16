import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface ModelEvent { type: string; assistantMessageEvent?: unknown; message?: unknown; }
interface ModelDiagnosticScope { engine: "omp"; scope: "chat" | "wiki" | "ssh" | "playground" | "auth"; runId?: string; }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const eventTypes = new Set(["agent_start", "agent_end", "agent_settled", "session_settled", "message_start", "message_update", "message_end", "turn_start", "turn_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_compaction_start", "auto_compaction_end", "auto_retry_start", "auto_retry_end", "prompt_result", "harness_model_loop"]);
const streamTypes = new Set(["start", "text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error"]);
const stopReasons = new Set(["stop", "length", "toolUse", "error", "aborted"]);
const blockTypes = new Set(["text", "thinking", "toolCall", "image"]);
const label = (value: unknown, allowed: Set<string>) => typeof value === "string" && allowed.has(value) ? value : "other";

/** Metadata only: never serialize SDK events, prompts, tool arguments or errors. */
export function diagnosticEvent(event: ModelEvent): Record<string, unknown> {
	const result: Record<string, unknown> = { type: label(event.type, eventTypes) };
	if (event.type === "message_update") {
		const delta = record(event.assistantMessageEvent);
		result.streamType = label(delta.type, streamTypes);
		if (typeof delta.contentIndex === "number" && Number.isSafeInteger(delta.contentIndex) && delta.contentIndex >= 0) result.contentIndex = delta.contentIndex;
		if (typeof delta.delta === "string") result.characters = delta.delta.length;
	}
	const message = record(event.message);
	if (event.type === "message_end" && message.role === "assistant") {
		result.stopReason = label(message.stopReason, stopReasons);
		const usage = record(message.usage);
		result.usage = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].flatMap(key => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0 ? [[key, usage[key]]] : []));
		const blocks = Array.isArray(message.content) ? message.content : [];
		result.blockCount = blocks.length;
		result.blocks = blocks.slice(0, 256).map(block => ({ type: label(record(block).type, blockTypes) }));
	}
	return result;
}

/** Opt-in, bounded, per-subscription trace. Failure must never interrupt a task. */
export function createModelDiagnostics(directory = process.env.PI_WEB_MODEL_DIAGNOSTICS_DIR, scope?: ModelDiagnosticScope): (event: ModelEvent) => void {
	if (!directory) return () => {};
	let bytes = 0;
	let failed = false;
	const started = Date.now();
	const file = join(directory, `model-events-${randomUUID()}.jsonl`);
	try { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
	catch { return () => {}; }
	return event => {
		if (failed || bytes >= 8 * 1024 * 1024) return;
		try {
			const line = JSON.stringify({ ...scope, elapsedMs: Date.now() - started, ...diagnosticEvent(event) }) + "\n";
			if (bytes + Buffer.byteLength(line) > 8 * 1024 * 1024) { failed = true; return; }
			appendFileSync(file, line, { mode: 0o600 });
			bytes += Buffer.byteLength(line);
		} catch { failed = true; }
	};
}
