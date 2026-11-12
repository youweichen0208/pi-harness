import { statSync } from "node:fs";

/** A persisted session's project directory is usable only while it still exists as a directory. */
export function isSessionDirectory(path: string): boolean {
	try { return statSync(path).isDirectory(); } catch { return false; }
}
