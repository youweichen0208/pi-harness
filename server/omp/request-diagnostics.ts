/** Content-free request observations. This module never changes provider input. */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const enumeration = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value) ? value : "other";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const roles = ["system", "developer", "user", "assistant", "tool", "function", "model"];
const blockTypes = ["text", "input_text", "output_text", "thinking", "redacted_thinking", "reasoning", "tool_use", "tool_result", "function_call", "function_call_output", "image", "image_url", "input_image", "message"];
const levels = ["enabled", "disabled", "adaptive", "none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const MAX_RECORDS = 256, MAX_BYTES = 8 * 1024 * 1024;

export function requestProjection(payload: unknown, key: Uint8Array) {
	const digest = (value: unknown): string | undefined => value === undefined ? undefined : createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
	const schema = (value: unknown) => {
		const doc = record(value);
		return { digest: digest(value), type: enumeration(doc.type, ["object", "array", "string", "number", "integer", "boolean", "null"]), properties: Object.keys(record(doc.properties)).length, required: Array.isArray(doc.required) ? doc.required.length : undefined };
	};
	const block = (value: unknown) => {
		const item = record(value);
		return { type: typeof value === "string" ? "text" : enumeration(item.type, blockTypes), digest: digest(value),
			call: digest(item.tool_use_id ?? item.call_id ?? item.id), name: digest(item.name),
			characters: typeof value === "string" ? value.length : typeof item.text === "string" ? item.text.length : typeof item.thinking === "string" ? item.thinking.length : undefined,
			signature: typeof item.signature === "string" || typeof item.encrypted_content === "string",
			arguments: digest(item.input ?? item.arguments), result: digest(item.output ?? (item.type === "tool_result" ? item.content : undefined)) };
	};
	const doc = record(payload), thinking = record(doc.thinking), reasoning = record(doc.reasoning), output = record(doc.output_config);
	const messages = Array.isArray(doc.messages) ? doc.messages : Array.isArray(doc.input) ? doc.input : [];
	const tools = Array.isArray(doc.tools) ? doc.tools : [];
	return {
		digest: digest(payload), model: digest(doc.model), stream: typeof doc.stream === "boolean" ? doc.stream : undefined,
		maxTokens: number(doc.max_tokens), maxCompletionTokens: number(doc.max_completion_tokens), maxOutputTokens: number(doc.max_output_tokens),
		temperature: number(doc.temperature), topP: number(doc.top_p),
		thinking: { type: enumeration(thinking.type, levels), budgetTokens: number(thinking.budget_tokens), effort: enumeration(output.effort ?? reasoning.effort ?? doc.reasoning_effort, levels) },
		system: digest(doc.system ?? doc.instructions), toolChoice: digest(doc.tool_choice),
		messageCount: messages.length, messagesTruncated: messages.length > MAX_RECORDS,
		messages: messages.slice(-MAX_RECORDS).map((value, index) => {
			const item = record(value), content = Array.isArray(item.content) ? item.content : item.content === undefined ? [] : [item.content];
			const calls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
			return { index: Math.max(0, messages.length - MAX_RECORDS) + index, role: enumeration(item.role, roles), digest: digest(value),
				item: item.type ? block(item) : undefined, call: digest(item.tool_call_id),
				blockCount: content.length, blocksTruncated: content.length > MAX_RECORDS, blocks: content.slice(0, MAX_RECORDS).map(block),
				toolCallCount: calls.length, callsTruncated: calls.length > MAX_RECORDS,
				calls: calls.slice(0, MAX_RECORDS).map(call => { const tool = record(call), fn = record(tool.function); return { call: digest(tool.id), name: digest(fn.name), arguments: digest(fn.arguments) }; }) };
		}),
		toolCount: tools.length, toolsTruncated: tools.length > MAX_RECORDS,
		tools: tools.slice(0, MAX_RECORDS).map(value => { const item = record(value), fn = record(item.function ?? item); return { name: digest(fn.name), digest: digest(value), schema: schema(fn.input_schema ?? fn.parameters) }; }),
	};
}

/** The local HMAC key is never included in diagnostic records or downloads. */
function localKey(directory: string) {
	const path = join(directory, ".request-diagnostics-key");
	try { writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size !== 32 || stat.nlink !== 1) throw Error("Invalid diagnostic key");
		return readFileSync(fd);
	} finally { closeSync(fd); }
}

export function createRequestDiagnostics(directory: string | undefined) {
	if (!directory) return undefined;
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const key = localKey(directory), file = join(directory, `provider-events-${randomUUID()}.jsonl`), started = Date.now();
		let bytes = 0, sequence = 0, failed = false;
		const digest = (value: unknown) => value === undefined ? undefined : createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
		return {
			project: (payload: unknown) => requestProjection(payload, key), digest,
			write(event: Record<string, unknown>) {
				if (failed) return;
				try {
					const line = JSON.stringify({ ...event, sequence: ++sequence, elapsedMs: Date.now() - started }) + "\n", length = Buffer.byteLength(line);
					if (bytes + length > MAX_BYTES - 512) {
						appendFileSync(file, JSON.stringify({ type: "diagnostics_limit", elapsedMs: Date.now() - started }) + "\n", { mode: 0o600 }); failed = true; return;
					}
					appendFileSync(file, line, { mode: 0o600 }); bytes += length;
				} catch { failed = true; }
			},
		};
	} catch { return undefined; }
}
