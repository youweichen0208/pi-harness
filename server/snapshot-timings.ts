/**
 * Bounded timing channel for the snapshot pipeline. Summary collection is on
 * by default; PI_SNAPSHOT_TIMINGS=1/detail also scans each serialized message
 * for byte distributions. Set PI_SNAPSHOT_TIMINGS=off/0/false to disable it.
 *
 * Two record kinds:
 *  - marks   — durations. `ms` samples for a named set are retained in a fixed
 *              ring buffer (2048) so p50/p95 can be derived; every name keeps
 *              count/total/max regardless.
 *  - counters — additive integers (cache hits, bytes, message kinds).
 *
 * ORIENTATION: every *_total / *_ms mark is INCLUSIVE — it spans the whole
 * function from entry to exit, so nested marks are already inside it. Never
 * sum nested marks. Compare `snapshot_total` (end-to-end) against its largest
 * child, or take the difference of two layers (e.g.
 * `snapshot_total - current_messages - light_state` = everything else).
 *
 * `snapshot_total:<kind>` is THE SAME sampling as `snapshot_total`, only
 * labelled (kind = `snapshot` | `snapshot_delta`). The bare mark is the mixed
 * full+delta distribution kept for continuity with older runs; per-kind
 * conclusions must cite the labelled one.
 */

export interface TimingStat {
	count: number;
	totalMs: number;
	maxMs: number;
	/** Null when this mark keeps aggregates only and has no retained samples. */
	p50: number | null;
	p95: number | null;
}

export interface TimingsReport {
	marks: Record<string, TimingStat>;
	counters: Record<string, number>;
	/** Per-message-type wire byte samples. Always present (may be empty). */
	bytes: Record<string, ByteStat>;
}

/** Wire bytes per MESSAGE TYPE.
 *
 *  `total` is the cumulative bytes of that type; `p50`/`p95` are the size
 *  distribution of ONE message of that type. Never substitute
 *  `total / (number of snapshots)` for the distribution, and never describe
 *  the `other` bucket's `total` as "one other message".
 */
export interface ByteStat {
	count: number;
	total: number;
	max: number;
	p50: number;
	p95: number;
}

/** Marks whose individual samples are retained (p50/p95). */
const SAMPLED_EXACT: Record<string, true> = {
	snapshot_total: true,
	metadata_hash_snapshot: true,
	current_messages: true,
	light_state: true,
	ws_serialize_cold: true,
	ws_serialize_hit: true,
	ws_byte_length: true,
};
/** Per-kind labels of an already-sampled mark: `snapshot_total:snapshot`,
 *  `snapshot_total:snapshot_delta`. A mixed p95 across both kinds is what the
 *  benchmark used to cite as "full snapshot p95". */
const SAMPLED_PREFIXES: readonly string[] = ["snapshot_total:"];

const RING = 2048;
/** Hard cap on distinct mark names — a typo must not grow memory without bound. */
const MAX_NAMES = 24;
/** Caps the per-type entries inside the `other` byte bucket; the bucket itself
 *  is permanent, so bytes are never lost — only the breakdown. */
const MAX_BYTE_NAMES = 16;
/** Types whose byte distribution is always kept, no matter how many message
 *  types the host emits. Everything else lands in `other`. */
const BYTE_CORE: readonly string[] = ["snapshot", "snapshot_delta"];

interface Entry {
	count: number;
	totalMs: number;
	maxMs: number;
	samples: number[];
}

/** Linear interpolation between closest ranks (matches numpy's default). */
function quantile(sorted: readonly number[], q: number): number | null {
	if (sorted.length === 0) return null;
	const pos = (sorted.length - 1) * q;
	const lower = Math.floor(pos);
	const upper = Math.ceil(pos);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

export class SnapshotTimings {
	/** Summary is the default; detail retains legacy per-message byte scans. */
	readonly enabled: boolean;
	readonly detailed: boolean;
	private readonly marks = new Map<string, Entry>();
	private readonly counters = new Map<string, number>();
	/** Reserved core types first, then the `other` bucket (never evicted), then
	 *  its per-type breakdown (capped by MAX_BYTE_NAMES). */
	private readonly byteEntries = new Map<string, Entry>([
		...BYTE_CORE.map((type): [string, Entry] => [`wire_bytes_p50:${type}`, { count: 0, totalMs: 0, maxMs: 0, samples: [] }]),
		["wire_bytes_p50:other", { count: 0, totalMs: 0, maxMs: 0, samples: [] }],
	]);
	private byteOthers = 0;
	private byteDropped = 0;

	constructor(mode?: boolean | string) {
		const value = typeof mode === "boolean" ? (mode ? "detail" : "off") : mode ?? process.env.PI_SNAPSHOT_TIMINGS ?? "summary";
		const normalized = value.toLowerCase();
		this.enabled = !["0", "off", "false"].includes(normalized);
		this.detailed = this.enabled && (normalized === "1" || normalized === "detail");
	}

	/** Record one duration sample (milliseconds). */
	add(name: string, ms: number): void {
		if (!this.enabled) return;
		let entry = this.marks.get(name);
		if (!entry) {
			if (this.marks.size >= MAX_NAMES) return;
			entry = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
			this.marks.set(name, entry);
		}
		entry.count += 1;
		entry.totalMs += ms;
		if (ms > entry.maxMs) entry.maxMs = ms;
		if (SAMPLED_EXACT[name] === true || SAMPLED_PREFIXES.some((p) => name.startsWith(p))) {
			if (entry.samples.length < RING) entry.samples.push(ms);
			else entry.samples[(entry.count - 1) % RING] = ms;
		}
	}

	/** Record an additive count (hits, bytes, message kinds). */
	count(name: string, n = 1): void {
		if (!this.enabled) return;
		this.counters.set(name, (this.counters.get(name) ?? 0) + n);
	}

	/** Record one wire message's size (bytes) under its message type.
	 *  `snapshot` / `snapshot_delta` are reserved at construction and always
	 *  keep their distribution; other types get their own entry while slots
	 *  last. Every non-core type also rolls into the permanent `other` bucket,
	 *  so bytes are never lost — at worst the per-type breakdown is. */
	addBytes(type: string, bytes: number): void {
		if (!this.enabled) return;
		const name = `wire_bytes_p50:${type}`;
		let entry = this.byteEntries.get(name);
		const cores = BYTE_CORE.includes(type);
		if (!entry && !cores && type !== "other") {
			if (this.byteOthers < MAX_BYTE_NAMES) {
				this.byteOthers += 1;
				this.byteEntries.set(name, { count: 0, totalMs: 0, maxMs: 0, samples: [] });
				entry = this.byteEntries.get(name);
			} else {
				// Breakdown is full: the type keeps only its place in `other`.
				this.byteDropped += 1;
			}
		}
		if (entry) this.pushBytes(entry, bytes);
		if (!cores) {
			const bucket = this.byteEntries.get("wire_bytes_p50:other");
			if (bucket) this.pushBytes(bucket, bytes);
		}
	}

	private pushBytes(entry: Entry, bytes: number): void {
		entry.count += 1;
		entry.totalMs += bytes;
		if (bytes > entry.maxMs) entry.maxMs = bytes;
		if (entry.samples.length < RING) entry.samples.push(bytes);
		else entry.samples[(entry.count - 1) % RING] = bytes;
	}

	report(): TimingsReport {
		const marks: Record<string, TimingStat> = {};
		for (const [name, entry] of this.marks) {
			const sorted = [...entry.samples].sort((a, b) => a - b);
			marks[name] = {
				count: entry.count,
				totalMs: entry.totalMs,
				maxMs: entry.maxMs,
				p50: quantile(sorted, 0.5),
				p95: quantile(sorted, 0.95),
			};
		}
		const bytes: Record<string, ByteStat> = {};
		for (const [name, entry] of this.byteEntries) {
			if (entry.count === 0) continue;
			const sorted = [...entry.samples].sort((a, b) => a - b);
			bytes[name] = {
				count: entry.count,
				total: entry.totalMs,
				max: entry.maxMs,
				p50: quantile(sorted, 0.5) ?? 0,
				p95: quantile(sorted, 0.95) ?? 0,
			};
		}
		const counters = Object.fromEntries(this.counters);
		if (this.byteDropped > 0) counters.bytes_name_dropped = this.byteDropped;
		return { marks, counters, bytes };
	}

	reset(): void {
		this.marks.clear();
		this.counters.clear();
		this.byteEntries.clear();
		for (const type of BYTE_CORE) this.byteEntries.set(`wire_bytes_p50:${type}`, { count: 0, totalMs: 0, maxMs: 0, samples: [] });
		this.byteEntries.set("wire_bytes_p50:other", { count: 0, totalMs: 0, maxMs: 0, samples: [] });
		this.byteOthers = 0;
		this.byteDropped = 0;
	}
}
