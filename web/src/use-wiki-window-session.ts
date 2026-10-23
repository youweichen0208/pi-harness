import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { WikiWindowSession, type WikiWindowMemory } from "./wiki-window-session";
import { knowledgeLibrary } from "./knowledge-library";
import { isKnowledgeLibraryWindow, isWikiWindow, wikiWindowCarry, wikiWindowClient, wikiWindowParams } from "./wiki-window";
import type { ChatState } from "./use-chat";
import type { ClientMessage } from "./types";

const STORAGE_KEY = "pi-wiki-view";
export function useWikiWindowSession(options: {
	chat: ChatState; switching: boolean; switchError: boolean; opened: boolean;
	send(message: ClientMessage): boolean;
	enter(path: string | null, reuse: boolean): Promise<boolean>;
	restore(memory: WikiWindowMemory): void;
	changeFolder(path: string): void;
	warn(message: string): void;
}) {
	const live = useRef(options); live.current = options;
	const [session] = useState(() => new WikiWindowSession(isKnowledgeLibraryWindow, isWikiWindow, {
		params: () => ({ ...wikiWindowParams(), ...wikiWindowCarry(), client: wikiWindowClient() }),
		target(cwd, path) {
			const url = new URL(location.href); url.searchParams.set("cwd", cwd);
			if (path) url.searchParams.set("doc", path); else url.searchParams.delete("doc");
			history.replaceState(null, "", url);
		},
		readMemory() { try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null"); } catch { return null; } },
		writeMemory(memory) { try { if (memory) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memory)); else sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage can be unavailable */ } },
		configure: knowledgeLibrary,
		send: message => live.current.send(message),
		enter: (path, reuse) => live.current.enter(path, reuse),
		restore: memory => live.current.restore(memory),
		changeFolder: path => live.current.changeFolder(path),
		warn: message => live.current.warn(message),
	}));
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
	useEffect(session.connect, [session]);
	const { chat, switching, switchError, opened } = options;
	useEffect(() => {
		session.observe({
			ready: chat.ready, switching, switchError, opened,
			cwd: chat.state?.cwd, conversationId: chat.state?.conversationId ?? chat.activeConversationId,
			sessionId: chat.state?.sessionId, wiki: chat.state?.wiki === true,
			model: chat.state?.model ? chat.state.model.provider + "/" + chat.state.model.id : null,
			models: chat.models, thinking: chat.state?.thinkingLevel, availableThinking: chat.state?.availableThinkingLevels,
		});
	}, [session, chat.ready, chat.state, chat.activeConversationId, chat.models, switching, switchError, opened]);
	return { session, ...state };
}
