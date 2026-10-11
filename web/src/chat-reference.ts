/** UI-only transfer: never sends a prompt or attaches an entire document. */
export interface ChatReferenceRequest {
	database?: { id: string; name: string; version: string };
	id: string;
	cwd: string;
	conversationId: string;
	path: string;
	text: string;
}

export function appendChatReference(draft: string, request: ChatReferenceRequest): string {
	const quote = request.text.split("\n").map(line => `> ${line}`).join("\n");
	return `${draft}${draft ? "\n\n" : ""}${request.path}\n\n${quote}\n\n`;
}

/** Rejected requests are also consumed, so switching back cannot replay them. */
export function takeChatReference(request: ChatReferenceRequest | null | undefined,
	cwd: string, conversationId: string, consumed: Set<string>): ChatReferenceRequest | null {
	if (!request || consumed.has(request.id)) return null;
	consumed.add(request.id);
	return request.cwd === cwd && request.conversationId === conversationId ? request : null;
}
