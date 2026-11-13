import { useSyncExternalStore } from "react";
import type { PlaygroundChatEvent, PlaygroundChatRequest, PlaygroundChatState } from "./types";
import { randomUuid } from "./uuid";

type View = { state?: PlaygroundChatState; draft: string; pending?: string; error?: string; connected: boolean };
const KEY = "pi-playground-chat-draft";
let view: View = { draft: sessionStorage.getItem(KEY) ?? "", connected: false };
let pending: { id: string; text: string; created: number } | undefined;
try { pending = JSON.parse(sessionStorage.getItem(KEY + "-pending") ?? "null") ?? undefined; } catch { /* Invalid local recovery data. */ }
if (pending) view.pending = pending.id;
let lastSent: { text: string; conversationId: string; id: string } | undefined;
try { lastSent = JSON.parse(sessionStorage.getItem(KEY + "-last") ?? "null") ?? undefined; } catch { /* Invalid recovery data. */ }
let restoredFailure: string | undefined;
const listeners = new Set<() => void>();
let opened = false;
function publish(patch: Partial<View>) { view = { ...view, ...patch }; for (const listener of listeners) listener(); }
export function playgroundChatRequest(action: PlaygroundChatRequest["action"], extra: Partial<PlaygroundChatRequest> = {}) {
	window.dispatchEvent(new CustomEvent("pi:playground-request", { detail: { type: "playground_chat", action, requestId: randomUuid(), conversationId: view.state?.id, ...extra } }));
}
export function playgroundChatConnection(connected: boolean) {
	publish({ connected });
	if (connected && opened) { playgroundChatRequest("open"); if (pending) playgroundChatRequest("receipt", { requestId: pending.id }); }
}
export function playgroundChatEvent(event: PlaygroundChatEvent) {
	if (event.type === "playground_chat_state") {
		const changed = view.state?.id !== event.state.id || view.state?.model?.provider !== event.state.model?.provider || view.state?.model?.id !== event.state.model?.id;
		publish({ state: event.state, ...(changed ? { error: undefined } : {}) });
		if (event.state.error && lastSent?.conversationId === event.state.id && restoredFailure !== lastSent.id) {
			restoredFailure = lastSent.id;
			if (!view.draft) editPlaygroundQuestion(lastSent.text);
		}
	}
	if (event.type === "playground_chat_error") {
		if (pending?.id === event.requestId) { pending = undefined; sessionStorage.removeItem(KEY + "-pending"); }
		publish({ error: event.error, pending: pending?.id });
	}
	if (event.type === "playground_chat_result" && event.result.requestId === pending?.id) {
		if (event.result.receipt === "processing" && Date.now() - (pending.created ?? 0) < 30000) { setTimeout(() => { if (pending && view.connected) playgroundChatRequest("receipt", { requestId: pending.id }); }, 1000); return; }
		if (event.result.ok && view.draft === pending.text) editPlaygroundQuestion("");
		pending = undefined; sessionStorage.removeItem(KEY + "-pending");
		publish({ pending: undefined, ...(event.result.ok ? {} : { error: view.error ?? "pgChatUnconfirmed" }) });
	}
}
export function openPlaygroundChat(model?: PlaygroundChatRequest["model"], thinking?: string) { opened = true; playgroundChatRequest("open", { model, thinking }); if (pending) playgroundChatRequest("receipt", { requestId: pending.id }); }
export function editPlaygroundQuestion(draft: string) { sessionStorage.setItem(KEY, draft); publish({ draft }); }
export function sendPlaygroundQuestion(context: PlaygroundChatRequest["context"]) {
	if (!view.connected || view.pending || !view.state || view.state.running || !view.state.model || !view.state.models.some(m => m.provider === view.state!.model!.provider && m.id === view.state!.model!.id) || !view.draft.trim()) return;
	pending = { id: randomUuid(), text: view.draft, created: Date.now() };
	sessionStorage.setItem(KEY + "-pending", JSON.stringify(pending));
	lastSent = { text: view.draft, conversationId: view.state.id, id: pending.id };
	sessionStorage.setItem(KEY + "-last", JSON.stringify(lastSent));
	publish({ pending: pending.id, error: undefined });
	const id = pending.id;
	playgroundChatRequest("send", { requestId: id, text: pending.text, context });
	setTimeout(() => { if (pending?.id === id) { playgroundChatRequest("receipt", { requestId: id }); } }, 30000);
}
export function usePlaygroundChat() {
	return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => view);
}
