import type { PromptAttachment } from "../protocol.js";
import { frozenAttachmentText, resolveNativeAttachments } from "../user-attachments.js";
import { isRecord } from "./framing.js";
import type { OmpSession } from "./session.js";
import type { AttachmentMessage } from "../attachments.js";
import { nativeEntryMessage, skillUserDraft } from "./native-messages.js";

export function composeOmpPrompt(text: string, asides: { message: AttachmentMessage }[]) {
	const images: { type: "image"; data: string; mimeType: string }[] = [];
	const content: string[] = [];
	for (const aside of asides) for (const block of typeof aside.message.content === "string" ? [{ type: "text" as const, text: aside.message.content }] : aside.message.content) {
		if (block.type === "text") content.push(block.text);
		if (block.type === "image") images.push(block);
	}
	// Native executable commands split at a literal space. Preserve a bare
	// command's name when host text attachments introduce its first arguments.
	const bareCommand = text.startsWith("/") && text.length > 1 && !/\s/u.test(text);
	const prompt = content.length && bareCommand ? `${text} ` : text;
	return { message: [prompt, ...content].join("\n\n"), images };
}

/** Resolve against this native session before navigation can change its history. */
export async function resolveOmpAttachments(session: Pick<OmpSession, "command">, attachments?: PromptAttachment[]): Promise<PromptAttachment[] | undefined> {
	if (!attachments?.some(attachment => attachment.nativeRef && frozenAttachmentText(attachment) === undefined)) return attachments;
	const response = await session.command("get_entries");
	if (!isRecord(response.data) || !Array.isArray(response.data.entries)) throw Error("Native attachment history unavailable");
	const entries = new Map(response.data.entries.flatMap(entry => isRecord(entry) && typeof entry.id === "string" ? [[entry.id, entry] as const] : []));
	return resolveNativeAttachments({ sessionManager: { getEntry(id) {
		const entry = entries.get(id);
		const message = nativeEntryMessage(entry);
		if (!entry || typeof entry.type !== "string" || !isRecord(message) || typeof message.role !== "string") return;
		const draft = skillUserDraft(message);
		if (draft !== undefined) return { type: "message", message: { role: "user", content: draft } };
		return { type: entry.type, message: { role: message.role, content: message.content,
			...(typeof message.customType === "string" ? { customType: message.customType } : {}) } };
	} } }, attachments);
}
