import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface OmpToolOutput {
	text: string;
	artifacts: { id: string; path: string | null; name: string; default: boolean; partial: boolean }[];
}
export type OmpTaskOutputPath = { nativeId: string; parentToolCallId: string }[];
export const outputDenied = () => Object.assign(Error("Output access denied"), { code: "EACCES" });

/** Only a native artifact of this transcript; never accept a workspace path or follow symlinks. */
export async function openOmpArtifact(sessionFile: string, path: string | null) {
	if (!path) throw Object.assign(Error("Output file missing"), { code: "ENOENT" });
	const root = resolve(sessionFile.slice(0, -6)), candidate = resolve(path);
	if (!sessionFile.endsWith(".jsonl") || dirname(candidate) !== root || !/^\d{1,20}\.[A-Za-z0-9_-]{1,64}\.log$/.test(basename(candidate))) throw outputDenied();
	if (await realpath(root) !== root || await realpath(candidate) !== candidate) throw outputDenied();
	const before = await lstat(candidate);
	if (!before.isFile() || before.isSymbolicLink()) throw outputDenied();
	const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const opened = await handle.stat(), after = await lstat(candidate);
		if (!opened.isFile() || after.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== after.dev || opened.ino !== after.ino || await realpath(candidate) !== candidate) throw outputDenied();
		return handle;
	} catch (error) { await handle.close(); throw error; }
}
