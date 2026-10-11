import { describe, expect, it } from "vitest";
import { appendChatReference, takeChatReference, type ChatReferenceRequest } from "../../web/src/chat-reference.js";

const request: ChatReferenceRequest = { id: "quote-1", cwd: "/project", conversationId: "original", path: "docs/notes.md", text: "Chosen text\n\nOnly this selection" };
describe("document quote transfer", () => {
	it("preserves the existing draft exactly and quotes only the captured selection", () => {
		expect(appendChatReference("unfinished draft  ", request)).toBe("unfinished draft  \n\ndocs/notes.md\n\n> Chosen text\n> \n> Only this selection\n\n");
	});
	it("consumes duplicate events once, including copies with the same id", () => {
		const consumed = new Set<string>();
		expect(takeChatReference(request, request.cwd, request.conversationId, consumed)).toBe(request);
		expect(takeChatReference({ ...request }, request.cwd, request.conversationId, consumed)).toBeNull();
		expect(takeChatReference({ ...request, id: "quote-2" }, request.cwd, request.conversationId, consumed)).not.toBeNull();
	});
	it.each([["/other-project", "original"], ["/project", "other-conversation"]])("drops late requests for %s / %s even after returning", (cwd, conversationId) => {
		const consumed = new Set<string>();
		expect(takeChatReference(request, cwd, conversationId, consumed)).toBeNull();
		expect(takeChatReference(request, request.cwd, request.conversationId, consumed)).toBeNull();
	});
});
