import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeFileAtomic } from "./private-file.js";
import { wikiPath } from "./wiki-service.js";
import type { WikiChatSummary } from "./protocol.js";

/** Native transcripts live outside the ordinary SDK session directory. */
export class WikiChatStore {
	constructor(private root: string) {}
	directory(cwd: string): string {
		const dir = join(this.root, createHash("sha256").update(realpathSync(cwd)).digest("hex"), "sessions");
		mkdirSync(dir, { recursive: true });
		return dir;
	}
	private metadata(cwd: string, id: string): string {
		if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid Wiki session");
		return join(this.directory(cwd), `${id}.meta.json`);
	}
	settings(cwd: string, id: string): { title?: string; references: string[]; opened?: number; documentPath?: string } {
		try { return JSON.parse(readFileSync(this.metadata(cwd, id), "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { references: [] }; }
	}
	update(cwd: string, id: string, patch: { title?: string; references?: string[]; opened?: number; documentPath?: string }): void {
		writeFileAtomic(this.metadata(cwd, id), JSON.stringify({ ...this.settings(cwd, id), ...patch }));
	}
	validateReferences(cwd: string, paths: unknown): string[] {
		if (!Array.isArray(paths) || paths.length > 100 || paths.some(path => typeof path !== "string" || !/\.(md|markdown|txt)$/i.test(path))) throw new Error("Invalid document selection (maximum 100)");
		return [...new Set(paths.map(path => {
			const absolute = wikiPath(cwd, path);
			if (!statSync(absolute).isFile()) throw new Error(`Document unavailable: ${path}`);
			return relative(realpathSync(cwd), realpathSync(absolute)).split(sep).join("/");
		}))];
	}
	async list(cwd: string): Promise<WikiChatSummary[]> {
		return (await SessionManager.list(cwd, this.directory(cwd))).filter(item => item.messageCount > 0).map(item => {
			const meta = this.settings(cwd, item.id);
			return { id: item.id, title: meta.title || item.name || item.firstMessage.slice(0, 80), updated: Math.max(item.modified.getTime(), meta.opened ?? 0), references: meta.references, documentPath: meta.documentPath };
		}).sort((a, b) => b.updated - a.updated);
	}
	file(cwd: string, id: string): string {
		this.metadata(cwd, id);
		const file = SessionManager.findById(cwd, id, this.directory(cwd));
		if (!file) throw new Error("Wiki conversation not found");
		return file;
	}
	remove(cwd: string, id: string): void {
		rmSync(this.file(cwd, id));
		rmSync(this.metadata(cwd, id), { force: true });
	}
}
