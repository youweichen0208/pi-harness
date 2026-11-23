import type { BackgroundCommand } from "./types";
import { createContext } from "react";

/** Workspace of the rendered conversation, used to label relative tool paths. */
export const BackgroundContext = createContext<{ tasks?: BackgroundCommand[]; control?(id: string, action: "detach" | "stop"): void }>({});
export const WorkspacePathContext = createContext("");
