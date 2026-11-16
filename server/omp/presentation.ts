import type { UiContentBlock, UiMessage } from "../protocol.js";
import { isRecord } from "./framing.js";
import { parseUserAttachments, visibleUserPrompt } from "../user-attachments.js";
import { skillUserDraft } from "./native-messages.js";
import { parseDelegateNotification } from "../delegate-notification.js";

export interface OmpModel {
	provider: string;
	id: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	vision: boolean;
}
/** Explicit projection: provider credentials, headers and arbitrary SDK metadata stay in the worker. */
export function projectModel(value: unknown): OmpModel | undefined {
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") return;
	const capacity = (limit: unknown): limit is number | null => limit === null || typeof limit === "number" && Number.isFinite(limit) && limit > 0;
	if (!capacity(value.contextWindow) || !capacity(value.maxTokens)) return;
	return { provider: value.provider, id: value.id, name: typeof value.name === "string" ? value.name : value.id, contextWindow: value.contextWindow, maxTokens: value.maxTokens, reasoning: value.reasoning === true, vision: Array.isArray(value.input) && value.input.includes("image") };
}
function bounded(text: string, cap = 200_000) {
	return text.length <= cap ? { text } : { text: text.slice(0, cap) + "\n… [truncated]", truncated: true };
}
function block(value: unknown, durationMs?: number): UiContentBlock | undefined {
	if (!isRecord(value)) return;
	if (value.type === "text" && typeof value.text === "string") return { type: "text", ...bounded(value.text) };
	if (value.type === "thinking" && typeof value.thinking === "string") return { type: "thinking", thinking: bounded(value.thinking).text,
		...(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}) };
	if (value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string") {
		const args = value.arguments === undefined ? undefined : bounded(JSON.stringify(value.arguments), 20_000);
		return { type: "toolCall", id: value.id, name: value.name, argumentsText: args?.text, argumentsTruncated: args?.truncated };
	}
	if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string" && /^image\/(png|jpeg|webp|gif)$/.test(value.mimeType) && value.data.length <= 8 * 1024 * 1024) return { type: "image", mimeType: value.mimeType, dataUrl: `data:${value.mimeType};base64,${value.data}` };
}
/** A UI copy only; native transcript (including thinking signatures) is never rewritten. */
/** Whether the existing transcript renderer can display a native message. */
export function hasProjectedMessage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if ((value.role === "compactionSummary" || value.role === "branchSummary") && typeof value.summary === "string") return true;
	return ["user", "assistant", "toolResult", "custom", "bashExecution"].includes(String(value.role))
		&& !(value.role === "assistant" && value.stopReason === "aborted" && Array.isArray(value.content) && value.content.length === 0);
}

export function projectMessage(value: unknown, index: number, entryId?: string, durations?: Readonly<Record<string, number>>): UiMessage | undefined {
	if (isRecord(value) && (value.role === "compactionSummary" || value.role === "branchSummary") && typeof value.summary === "string") {
		return { id: `${value.role === "compactionSummary" ? "cs" : "bs"}-${value.timestamp}-${index}`, role: value.role, ...(entryId ? { entryId } : {}),
			content: [{ type: "text", ...bounded(value.summary) }], ...(typeof value.timestamp === "number" ? { timestamp: value.timestamp } : {}) };
	}
	if (!isRecord(value) || !hasProjectedMessage(value)) return;
	const skillDraft = skillUserDraft(value);
	const notificationText = value.role === "user" ? (typeof value.content === "string" ? value.content : Array.isArray(value.content)
		? value.content.flatMap(part => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "") : undefined;
	const delegate = notificationText !== undefined && parseDelegateNotification(notificationText);
	const role = delegate ? "custom" : skillDraft !== undefined ? "user" : String(value.role);
	// OMP emits this transient cancellation event but does not persist it.
	// The session interruption state carries the stop; retain all partial content.
	const sourceContent = skillDraft === undefined ? value.content : [{ type: "text", text: skillDraft }, ...(Array.isArray(value.content) ? value.content.filter(part => isRecord(part) && part.type === "image") : [])];
	const content = typeof sourceContent === "string" ? [{ type: "text", ...bounded(sourceContent) }] : Array.isArray(sourceContent) ? sourceContent.flatMap((b, nativeIndex) => { const projected = block(b, durations?.[nativeIndex]); return projected ? [projected] : []; }) : [];
	const out: UiMessage = { id: `${({ user: "u", assistant: "a", custom: "c", toolResult: "t", bashExecution: "b" } as Record<string, string>)[role]}-${value.timestamp}-${index}`, role, content };
	if (entryId) out.entryId = entryId;
	if (role === "user" && entryId) {
		// Parse the complete native body, never its bounded UI preview.
		const raw = skillDraft ?? (typeof value.content === "string" ? value.content : Array.isArray(value.content)
			? value.content.flatMap(part => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "");
		const parsed = parseUserAttachments(raw);
		const question = visibleUserPrompt(parsed.text);
		if (question !== raw) out.questionText = bounded(question).text;
		if (parsed.attachments.length) out.userAttachments = parsed.attachments.map((attachment, index) => ({ path: attachment.path, mode: attachment.mode,
			preview: attachment.preview.slice(0, 12000), nativeRef: { entryId, index } }));
	}
	if (typeof value.timestamp === "number") out.timestamp = value.timestamp;
	for (const key of ["model", "provider", "stopReason", "errorMessage", "toolCallId", "toolName", "customType"] as const) if (typeof value[key] === "string") out[key] = value[key].slice(0, 200_000);
	if (delegate) out.customType = "acp-delegate";
	if (typeof value.isError === "boolean") out.isError = value.isError;
	if (isRecord(value.usage)) {
		const number = (key: string) => typeof value.usage === "object" && value.usage !== null && typeof (value.usage as Record<string, unknown>)[key] === "number" ? (value.usage as Record<string, number>)[key] : 0;
		out.usage = { input: number("input"), output: number("output"), cacheRead: number("cacheRead"), cacheWrite: number("cacheWrite") };
	}
	if (role === "toolResult" && out.toolCallId) {
		out.id = `t-${out.toolCallId}`;
		if (isRecord(value.details)) {
			const meta = isRecord(value.details.meta) ? value.details.meta : {};
			const details = { ...(typeof value.details.exitCode === "number" ? { exitCode: value.details.exitCode } : {}),
				...(isRecord(meta.truncation) ? { truncation: { truncated: true } } : {}) };
			if (Object.keys(details).length) out.details = details;
		}
	}
	if (role === "bashExecution" && typeof value.output === "string") out.content = [{ type: "text", ...bounded(value.output, 100_000) }];
	return out;
}
