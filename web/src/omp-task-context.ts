import { createContext } from "react";
import type { ClientMessage, UiOmpTask } from "./types";

export const OmpTaskContext = createContext<{ tasks: UiOmpTask[]; conversationId: string; active: boolean; send: (message: ClientMessage) => boolean } | null>(null);
