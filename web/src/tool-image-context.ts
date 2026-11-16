import { createContext } from "react";

/** Actions belong to the rendered conversation, including a docked Wiki chat. */
export const ToolImageContext = createContext<{
	cwd: string;
	conversationId: string;
	active: boolean;
	attach?: (file: File, conversationId: string) => Promise<boolean>;
} | null>(null);
