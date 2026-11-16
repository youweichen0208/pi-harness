/** Bun-only, read-only history-list metadata; never opens a SessionManager. */
import { visitEntriesFromFileStream } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";

const stamp = (value: Stats) => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(":");
export class OmpHistoryMetadata {
	private cache = new Map<string, { stamp: string; count: number }>();
	async branchPoints(file: string): Promise<number | undefined> {
		try {
			const before = await stat(file);
			if (!before.isFile()) return;
			const version = stamp(before), cached = this.cache.get(file);
			if (cached?.stamp === version) return cached.count;
			let header = false, invalid = false;
			const parents = new Map<string, string | null>();
			await visitEntriesFromFileStream(file, entry => {
				if (!header) { header = entry.type === "session" && typeof entry.id === "string"; if (!header) { invalid = true; return false; } return; }
				if (entry.type === "session" || typeof entry.id !== "string" || parents.has(entry.id)) { invalid = true; return false; }
				parents.set(entry.id, entry.parentId);
			}, { throwIfMissing: true, onMalformedRecord: () => { invalid = true; }, yieldEveryBytes: 64 * 1024 });
			if (invalid || !header || stamp(await stat(file)) !== version) return;
			const children = new Map<string, number>();
			for (const parent of parents.values()) if (parent !== null && parents.has(parent)) children.set(parent, (children.get(parent) ?? 0) + 1);
			const count = [...children.values()].filter(value => value > 1).length;
			this.cache.delete(file); this.cache.set(file, { stamp: version, count });
			if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
			return count;
		} catch { return; }
	}
	async list(sessions: SessionInfo[]) {
		const selected = [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime() || b.created.getTime() - a.created.getTime() || a.path.localeCompare(b.path)).slice(0, 200);
		const results = selected.map(item => ({ id: item.id, path: item.path, name: item.title, parentSessionPath: item.parentSessionPath,
			firstMessage: item.firstMessage.slice(0, 1000), messageCount: item.messageCount, created: item.created.getTime(), modified: item.modified.getTime(), source: "web" as const,
			branchPoints: undefined as number | undefined }));
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(8, results.length) }, async () => {
			for (;;) { const index = next++; if (index >= results.length) return; results[index].branchPoints = await this.branchPoints(results[index].path); }
		}));
		return results;
	}
}
