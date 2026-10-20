import { createContext, type ReactNode } from "react";

/** The window supplies its outline inside the document scroll surface on desktop. */
export const WikiReadingOutline = createContext<ReactNode>(null);
