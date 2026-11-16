/** Bun-only read path. No SessionManager open, ownership claim, or agent initialization. */
import { visitEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { realpath, lstat } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import { isRecord } from "./framing.js";
import { outputDenied, type OmpToolOutput, type OmpTaskOutputPath } from "./tool-output.js";

/** The host resolves opaque task IDs; only a declared native ancestry may select a child transcript. */
export async function taskOutputFile(sessionFile: string, path: OmpTaskOutputPath): Promise<string> {
	if (!Array.isArray(path) || !path.length || path.length > 32) throw outputDenied();
	let file = sessionFile;
	for (const step of path) {
		if (!isRecord(step) || typeof step.nativeId !== "string" || !step.nativeId || step.nativeId.length > 500 || step.nativeId === "." || step.nativeId === ".." || /[\\/\0:]/.test(step.nativeId) || typeof step.parentToolCallId !== "string" || !step.parentToolCallId || step.parentToolCallId.length > 2000 || !file.endsWith(".jsonl")) throw outputDenied();
		if (await realpath(file) !== resolve(file) || !(await lstat(file)).isFile()) throw outputDenied();
		let declared = false;
		await visitEntriesFromFile(file, entry => {
			if (entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(block => block.type === "toolCall" && block.id === step.parentToolCallId && (block.name === "task" || block.name === "_task"))) { declared = true; return false; }
		});
		if (!declared) throw outputDenied();
		file = join(file.slice(0, -6), `${step.nativeId}.jsonl`);
	}
	if (await realpath(file) !== resolve(file) || !(await lstat(file)).isFile()) throw outputDenied();
	return file;
}

export async function nativeToolOutput(sessionFile: string, toolCallId: string, artifactSessionFile = sessionFile): Promise<OmpToolOutput> {
	if (!sessionFile.endsWith(".jsonl") || !toolCallId || toolCallId.length > 2000) throw Object.assign(Error("Output access denied"), { code: "EACCES" });
	let declared = false, result: Record<string, unknown> | undefined;
	await visitEntriesFromFile(sessionFile, entry => {
		if (entry.type !== "message") return;
		const message = entry.message;
		if (message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === toolCallId)) declared = true;
		if (declared && message.role === "toolResult" && message.toolCallId === toolCallId) { result = message as unknown as Record<string, unknown>; return false; }
	});
	if (!result || !Array.isArray(result.content)) throw Object.assign(Error("Output access denied"), { code: "EACCES" });
	const text = result.content.flatMap(block => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
	const meta = isRecord(result.details) && isRecord(result.details.meta) ? result.details.meta : {};
	const root = resolve(artifactSessionFile.slice(0, -6)), manager = new ArtifactManager(root);
	const sources = [meta.minimized, meta.truncation, meta.source].filter(isRecord);
	const artifacts: OmpToolOutput["artifacts"] = [];
	for (const source of sources) {
		if (!isRecord(source) || typeof source.artifactId !== "string" || !/^\d{1,20}$/.test(source.artifactId)) continue;
		const id = `artifact-${source.artifactId}`;
		if (artifacts.some(artifact => artifact.id === id)) continue;
		if (await realpath(root) !== root) throw Object.assign(Error("Output access denied"), { code: "EACCES" });
		const path = await manager.getPath(source.artifactId);
		if (path && (await realpath(path) !== resolve(path) || !(await lstat(path)).isFile() || !/^\d{1,20}\.[A-Za-z0-9_-]{1,64}\.log$/.test(basename(path)))) throw Object.assign(Error("Output access denied"), { code: "EACCES" });
		const partial = sources.some(item => item.artifactId === source.artifactId && typeof item.artifactElidedBytes === "number" && item.artifactElidedBytes > 0);
		artifacts.push({ id, path, name: `${partial ? "partial-" : ""}${path ? basename(path) : `${source.artifactId}.log`}`, default: artifacts.length === 0, partial });
	}
	return { text, artifacts };
}
