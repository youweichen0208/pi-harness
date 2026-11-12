import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { MissingSessionSummary } from "./protocol.js";

export function isSessionDirectory(path: string): boolean {
	try { return statSync(path).isDirectory(); } catch { return false; }
}

type Selection = { path: string; cwd: string; targetCwd: string; conversationId: string; fingerprint: string; expires: number };

/** Short-lived, client-owned selections. Browsers never choose source files or target directories. */
export class SessionRecovery {
	private selections = new Map<string, Selection>();
	private generation = 0;
	constructor(private readonly agentDir: string) {}
	private fingerprint(path: string): string {
		const root = realpathSync(join(this.agentDir, "sessions"));
		const actual = realpathSync(path), rel = relative(root, actual);
		if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !actual.endsWith(".jsonl")) throw new Error("会话不在原生历史目录中。");
		const stat = statSync(actual);
		if (!stat.isFile() || stat.size === 0) throw new Error("会话文件已失效，请刷新列表。");
		return `${actual}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	}
	async list(conversationId: string, targetCwd: string): Promise<MissingSessionSummary[]> {
		if (!isSessionDirectory(targetCwd)) throw new Error("当前项目目录已失效，请先打开一个有效项目。");
		const generation = ++this.generation;
		this.selections.clear();
		const infos = await SessionManager.listAll();
		if (generation !== this.generation) throw new Error("列表请求已被替换，请重试。");
		const results: MissingSessionSummary[] = [];
		for (const info of infos.sort((a, b) => b.modified.getTime() - a.modified.getTime())) {
			if (!info.cwd || isSessionDirectory(info.cwd)) continue;
			try {
				const path = resolve(info.path), fingerprint = this.fingerprint(path), token = randomUUID();
				this.selections.set(token, { path, cwd: info.cwd, targetCwd, conversationId, fingerprint, expires: Date.now() + 10 * 60_000 });
				results.push({ token, name: info.name, firstMessage: info.firstMessage.slice(0, 240), cwd: info.cwd, modified: info.modified.getTime() });
				if (results.length >= 200) break;
			} catch { /* Removed or invalid files are not selectable. */ }
		}
		return results;
	}
	cancel(token: string): void { this.selections.delete(token); }
	validate(token: string, conversationId: string, targetCwd: string): Selection {
		const selection = this.selections.get(token);
		if (!selection || selection.expires < Date.now() || selection.conversationId !== conversationId || selection.targetCwd !== targetCwd) throw new Error("恢复请求已失效，请重新展开历史列表。");
		if (!isSessionDirectory(targetCwd)) throw new Error("当前项目目录已失效，请先打开一个有效项目。");
		if (this.fingerprint(selection.path) !== selection.fingerprint) throw new Error("会话文件已变化，请刷新列表后重试。");
		if (isSessionDirectory(selection.cwd)) throw new Error("原项目目录已恢复，请从该项目打开会话。");
		return selection;
	}
}
