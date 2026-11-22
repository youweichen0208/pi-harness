import { useEffect } from "react";

/**
 * Pushing text into the composer from outside it.
 *
 * Same shape as `extension-editor`: a module-level queue plus a window event,
 * because the writer (a Run's result area, deep inside the message list) and the
 * reader (the composer) have no component relationship. It *appends* rather than
 * replacing, so handing a result to pi can never clobber a half-written draft.
 */

const EVENT = "pi-composer-append";
type ComposerInsertion = { text: string; placement: "append" | "command" };
const pending = new Map<string, ComposerInsertion[]>();

/** Queue text to append to a conversation's composer. */
export function appendComposerText(conversationId: string, text: string): void {
	queueInsertion(conversationId, { text, placement: "append" });
}

/** Prepare an explicit command invocation without sending or discarding a draft. */
export function prepareComposerCommand(conversationId: string, name: string): void {
	if (!/^(?:skill:)?[a-z0-9-]+$/.test(name)) throw Error("Invalid command name");
	queueInsertion(conversationId, { text: `/${name}`, placement: "command" });
}

export function insertComposerText(current: string, text: string, placement: ComposerInsertion["placement"]): string {
	if (placement === "append") return current.trim() ? `${current}\n\n${text}` : text;
	if (current === text || current.startsWith(`${text} `)) return current;
	// SDK command expansion separates the name at the first ASCII space.
	// Preserve the existing whitespace/draft, adding only that separator.
	if (current.startsWith(text) && /^\s/.test(current.slice(text.length))) return `${text} ${current.slice(text.length)}`;
	return `${text} ${current}`;
}

function queueInsertion(conversationId: string, insertion: ComposerInsertion): void {
	const queue = pending.get(conversationId) ?? [];
	queue.push(insertion);
	pending.set(conversationId, queue);
	try {
		window.dispatchEvent(new Event(EVENT));
	} catch {
		/* No window (SSR/tests): the queue is drained on the next consume. */
	}
}

export function useComposerAppend(conversationId: string, enabled: boolean, append: (text: string, placement: ComposerInsertion["placement"]) => void): void {
	useEffect(() => {
		if (!enabled) return;
		const consume = () => {
			const queue = pending.get(conversationId);
			if (!queue?.length) return;
			pending.delete(conversationId);
			for (const { text, placement } of queue) append(text, placement);
		};
		consume();
		window.addEventListener(EVENT, consume);
		return () => window.removeEventListener(EVENT, consume);
	}, [conversationId, enabled, append]);
}

const MODEL_SETTINGS_EVENT = "pi-composer-model-settings";

/** Open the model controls belonging to the same active composer. */
export function openComposerModelSettings(conversationId: string): void {
	window.dispatchEvent(new CustomEvent(MODEL_SETTINGS_EVENT, { detail: { conversationId } }));
}

export function useComposerModelSettings(conversationId: string, active: boolean, open: () => void): void {
	useEffect(() => {
		if (!active) return;
		const receive = (event: Event) => {
			if ((event as CustomEvent<{ conversationId: string }>).detail.conversationId === conversationId) open();
		};
		window.addEventListener(MODEL_SETTINGS_EVENT, receive);
		return () => window.removeEventListener(MODEL_SETTINGS_EVENT, receive);
	}, [conversationId, active, open]);
}
