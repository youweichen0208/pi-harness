import { createHash, type Hash } from "node:crypto";
import { openSync, closeSync, readSync, statSync, lstatSync, fstatSync, type BigIntStats } from "node:fs";
import { resolve } from "node:path";

type Stamp = { key: string; identity: string; size: number };
type Snapshot = { stamp: Stamp; hash: Hash };
const stampOf = (file: BigIntStats, link: BigIntStats = file): Stamp => ({
	key: `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}:${link.dev}:${link.ino}:${link.mtimeNs}:${link.ctimeNs}`,
	identity: `${file.dev}:${file.ino}:${link.dev}:${link.ino}`, size: Number(file.size),
});
const stamp = (path: string): Stamp | undefined => {
	try { return stampOf(statSync(path, { bigint: true }), lstatSync(path, { bigint: true })); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
};
const digest = (snapshot: Snapshot) => snapshot.hash.copy().digest("hex");

/** Tracks bytes the native storage actually read/wrote, independent of its JSON representation. */
export class HistoryFileGuard {
	private files = new Map<string, Snapshot | undefined>();
	private failure?: { external: boolean };
	private listeners = new Set<(external: boolean) => void>();
	/** Counts only guard scans, not native loading or writes. */
	bytesRead = 0;
	onFailure(listener: (external: boolean) => void) {
		this.listeners.add(listener);
		if (this.failure) listener(this.failure.external);
		return () => { this.listeners.delete(listener); };
	}
	tracks(path: string) { return path.endsWith(".jsonl") || this.files.has(resolve(path)); }
	fail(external: boolean): never {
		if (!this.failure) {
			this.failure = { external };
			for (const listener of this.listeners) listener(external);
		}
		// Deliberately not SessionWriteConflictError: a stale runtime must not
		// absorb the foreign edits or retry a full rewrite as native repair.
		throw Error(this.failure.external ? "Native history changed outside this runtime" : "Native history storage unavailable");
	}
	private assertValid() { if (this.failure) this.fail(this.failure.external); }
	private scan(path: string): Snapshot {
		const before = stamp(path);
		if (!before) return this.fail(true);
		const fd = openSync(path, "r"), hash = createHash("sha256"), chunk = Buffer.allocUnsafe(64 * 1024);
		try {
			const opened = fstatSync(fd, { bigint: true });
			let position = 0, n: number;
			while ((n = readSync(fd, chunk, 0, chunk.length, position)) > 0) { hash.update(chunk.subarray(0, n)); position += n; this.bytesRead += n; }
			const after = fstatSync(fd, { bigint: true });
			if (stampOf(opened).key !== stampOf(after).key || stamp(path)?.key !== before.key || position !== before.size) return this.fail(true);
			return { stamp: before, hash };
		} finally { closeSync(fd); }
	}
	/** A full native load must have observed one stable file, never half of two revisions. */
	beforeRead(path: string): Stamp | undefined {
		this.assertValid();
		if (this.files.has(resolve(path))) this.check(path);
		return stamp(path);
	}
	loaded(path: string, text: string, before: Stamp | undefined) {
		this.assertValid();
		const after = stamp(path);
		if (!before || after?.key !== before.key || Buffer.byteLength(text) !== after.size) this.fail(true);
		this.files.set(resolve(path), { stamp: after, hash: createHash("sha256").update(text) });
	}
	/** Unchanged files need stat only; a timestamp-only touch is accepted after a bounded-memory hash scan. */
	check(path: string): void {
		this.assertValid();
		if (!this.tracks(path)) return;
		const key = resolve(path), current = stamp(path);
		if (!this.files.has(key)) this.files.set(key, undefined);
		const expected = this.files.get(key);
		if (!expected) { if (current) this.fail(true); return; }
		if (!current || current.identity !== expected.stamp.identity || current.size !== expected.stamp.size) this.fail(true);
		if (current.key === expected.stamp.key) return;
		const actual = this.scan(path);
		if (digest(actual) !== digest(expected)) this.fail(true);
		this.files.set(key, actual);
	}
	/** Called synchronously after a native append has returned. */
	appended(path: string, line: string) {
		this.assertValid();
		const expected = this.files.get(resolve(path)), current = stamp(path);
		const size = (expected?.stamp.size ?? 0) + Buffer.byteLength(line);
		if (!current || current.size !== size) this.fail(true);
		const hash = expected?.hash.copy() ?? createHash("sha256");
		this.files.set(resolve(path), { stamp: current, hash: hash.update(line) });
	}
	/** FileSessionStorage's title update is synchronous before its Promise settles. */
	updatedTitle(path: string) { this.assertValid(); this.files.set(resolve(path), this.scan(path)); }
	openedEmpty(path: string) {
		const current = stamp(path);
		if (!current || current.size !== 0) this.fail(true);
		this.files.set(resolve(path), { stamp: current, hash: createHash("sha256") });
	}
	/** The public native rename hook runs inside its atomic-publish lock. Also tracks Windows move-aside/restore. */
	rename(source: string, target: string, publish: () => void) {
		this.assertValid();
		if (this.tracks(source)) this.check(source);
		if (this.tracks(target)) this.check(target);
		const sourceSnapshot = this.files.get(resolve(source)) ?? this.scan(source);
		if (this.tracks(target)) this.check(target);
		publish();
		const current = stamp(target);
		if (!current || current.size !== sourceSnapshot.stamp.size) this.fail(true);
		this.files.set(resolve(source), undefined);
		this.files.set(resolve(target), { stamp: current, hash: sourceSnapshot.hash.copy() });
	}
	removed(path: string) { this.assertValid(); this.files.set(resolve(path), undefined); }
}
