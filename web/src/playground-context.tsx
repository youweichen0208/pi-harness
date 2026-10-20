import { createContext, useContext, type ReactNode } from "react";
import type { PlaygroundStatus } from "./types";

/**
 * What a Run control needs from the app: the server's current answer about
 * execution, and a way to hand a result to pi. Provided once at the top and
 * consumed deep inside message rendering, which is why it is a context rather
 * than props through `MessageList` → `Message` → `Markdown`.
 */
export interface PlaygroundHost {
	status: PlaygroundStatus | null;
	/** Keys a Run's state, which outlives the component that started it. */
	conversationId: string;
	/** Insert a Run's output into the composer without sending it. */
	sendToPi: (text: string) => void;
}

const Host = createContext<PlaygroundHost>({ status: null, conversationId: "", sendToPi: () => {} });

export function PlaygroundProvider({ value, children }: { value: PlaygroundHost; children: ReactNode }) {
	return <Host.Provider value={value}>{children}</Host.Provider>;
}

export function usePlaygroundHost(): PlaygroundHost {
	return useContext(Host);
}
