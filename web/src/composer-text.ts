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
const pending = new Map<string, string[]>();

/** Queue text to append to a conversation's composer. */
export function appendComposerText(conversationId: string, text: string): void {
	const queue = pending.get(conversationId) ?? [];
	queue.push(text);
	pending.set(conversationId, queue);
	try {
		window.dispatchEvent(new Event(EVENT));
	} catch {
		/* No window (SSR/tests): the queue is drained on the next consume. */
	}
}

export function useComposerAppend(conversationId: string, enabled: boolean, append: (text: string) => void): void {
	useEffect(() => {
		if (!enabled) return;
		const consume = () => {
			const queue = pending.get(conversationId);
			if (!queue?.length) return;
			pending.delete(conversationId);
			for (const text of queue) append(text);
		};
		consume();
		window.addEventListener(EVENT, consume);
		return () => window.removeEventListener(EVENT, consume);
	}, [conversationId, enabled, append]);
}
