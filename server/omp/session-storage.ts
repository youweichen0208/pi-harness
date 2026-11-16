/** Bun-only adapter. Native serialization, blobs, locking and atomic publication remain in OMP. */
import { FileSessionStorage, isSessionLeaseHeld, SessionWriteConflictError, type SessionStorageWriteOptions, type WriteTextAtomicOptions, type SessionStorageWriter } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { existsSync, unlinkSync } from "node:fs";
import { HistoryFileGuard } from "./history-file-guard.js";

export class OmpSessionStorage extends FileSessionStorage {
	readonly guard = new HistoryFileGuard();
	private claims = new Map<string, number>();
	override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		const release = super.claimSession(sessionId, sessionPath);
		if (!release) return null;
		this.claims.set(sessionId, (this.claims.get(sessionId) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (this.claims.get(sessionId) ?? 1) - 1;
			if (remaining) this.claims.set(sessionId, remaining); else this.claims.delete(sessionId);
			release();
		};
	}
	/** Inspect only our writer during polling. A read-only native view can lag
	 * another window legitimately; its first write belongs to OMP's relocation
	 * logic. Actual storage writes always retain the strict byte guard below. */
	checkSession(path: string | undefined, sessionId: string, passive = false) {
		if (!path) return;
		if (!this.claims.has(sessionId)) {
			if (passive || isSessionLeaseHeld(sessionId) === true) return;
		}
		this.check(path);
	}
	private failed(error: unknown): never {
		// The native size precondition runs before renameSync. Classify an
		// intervening external edit here without allowing native repair to adopt it.
		if (error instanceof SessionWriteConflictError) this.guard.check(error.path);
		return this.guard.fail(false);
	}
	private checked<T>(operation: () => T): T {
		try { return operation(); } catch (error) { return this.failed(error); }
	}
	check(path: string | undefined) { if (path) this.checked(() => this.guard.check(path)); }
	override async readText(path: string): Promise<string> {
		if (!this.guard.tracks(path)) return super.readText(path);
		const before = this.checked(() => this.guard.beforeRead(path));
		const text = await super.readText(path);
		this.checked(() => this.guard.loaded(path, text, before));
		return text;
	}
	override readTextSync(path: string): string {
		if (!this.guard.tracks(path)) return super.readTextSync(path);
		return this.checked(() => {
			const before = this.guard.beforeRead(path), text = super.readTextSync(path);
			this.guard.loaded(path, text, before); return text;
		});
	}
	override writeTextSync(path: string, text: string, options?: SessionStorageWriteOptions): void {
		if (!this.guard.tracks(path)) return super.writeTextSync(path, text, options);
		this.checked(() => { this.guard.check(path); super.writeTextSync(path, text, options); });
	}
	override async writeTextAtomic(path: string, text: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (!this.guard.tracks(path)) return super.writeTextAtomic(path, text, options);
		this.check(path);
		try { await super.writeTextAtomic(path, text, options); } catch (error) { this.failed(error); }
	}
	override async writeText(path: string, text: string): Promise<void> {
		if (this.guard.tracks(path)) return this.writeTextAtomic(path, text);
		return super.writeText(path, text);
	}
	override renameSync(source: string, target: string): void {
		if (!this.guard.tracks(source) && !this.guard.tracks(target)) return super.renameSync(source, target);
		// Preserve EPERM for the SDK's Windows move-aside/restore fallback.
		this.guard.rename(source, target, () => super.renameSync(source, target));
	}
	override async rename(source: string, target: string): Promise<void> {
		if (!this.guard.tracks(source) && !this.guard.tracks(target)) return super.rename(source, target);
		this.checked(() => this.renameSync(source, target));
	}
	override async unlink(path: string): Promise<void> {
		if (!this.guard.tracks(path)) return super.unlink(path);
		this.checked(() => { this.guard.check(path); unlinkSync(path); this.guard.removed(path); });
	}
	override async updateSessionTitle(path: string, update: Parameters<FileSessionStorage["updateSessionTitle"]>[1]): Promise<void> {
		this.check(path);
		let pending: Promise<void> | undefined;
		try {
			pending = super.updateSessionTitle(path, update);
			this.guard.updatedTitle(path);
			await pending;
		} catch { await pending?.catch(() => {}); this.guard.fail(false); }
	}
	override openWriter(path: string, options?: Parameters<FileSessionStorage["openWriter"]>[1]): SessionStorageWriter {
		if (!this.guard.tracks(path)) return super.openWriter(path, options);
		return this.checked(() => {
			this.guard.check(path);
			const existed = existsSync(path);
			const writer = super.openWriter(path, options);
			if (!existed || options?.flags === "w") this.guard.openedEmpty(path);
			const appendSync = (line: string) => this.checked(() => {
				this.guard.check(path); writer.appendSync!(line); this.guard.appended(path, line);
			});
			return { appendSync, append: async line => appendSync(line), flush: () => writer.flush(), flushSync: () => writer.flushSync?.(),
				close: () => writer.close(), isOpen: () => writer.isOpen(), getError: () => writer.getError() };
		});
	}
}
