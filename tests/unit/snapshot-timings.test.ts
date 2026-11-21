import { describe, it, expect } from "vitest";
import { SnapshotTimings } from "../../server/snapshot-timings.js";

describe("SnapshotTimings", () => {
	it("records nothing while disabled", () => {
		const timings = new SnapshotTimings(false);
		timings.add("snapshot_total", 5);
		timings.count("cache_hit");
		expect(timings.enabled).toBe(false);
		expect(timings.report()).toEqual({ marks: {}, counters: {}, bytes: {} });
	});

	it("defaults to summary mode and reserves byte scanning for detail", () => {
		const summary = new SnapshotTimings("summary");
		expect(summary.enabled).toBe(true);
		expect(summary.detailed).toBe(false);
		const detail = new SnapshotTimings("detail");
		expect(detail.enabled).toBe(true);
		expect(detail.detailed).toBe(true);
		const legacy = new SnapshotTimings("1");
		expect(legacy.detailed).toBe(true);
	});

	it("derives p50/p95 by linear interpolation over retained samples", () => {
		const timings = new SnapshotTimings(true);
		for (let ms = 1; ms <= 100; ms++) timings.add("snapshot_total", ms);
		const stat = timings.report().marks.snapshot_total;
		expect(stat.count).toBe(100);
		expect(stat.totalMs).toBe(5050);
		expect(stat.maxMs).toBe(100);
		// positions: rank 49.5 → 50 + (51 - 50) * 0.5 ; rank 94.05 → 95 + 0.05
		expect(stat.p50).toBeCloseTo(50.5, 10);
		expect(stat.p95).toBeCloseTo(95.05, 10);
	});

	it("keeps count and total for high-frequency marks without inventing percentiles", () => {
		const timings = new SnapshotTimings(true);
		for (let i = 0; i < 5; i++) timings.add("cache_lookup", 2);
		const stat = timings.report().marks.cache_lookup;
		expect(stat).toEqual({ count: 5, totalMs: 10, maxMs: 2, p50: null, p95: null });
	});

	it("caps the sample ring but never the counters", () => {
		const timings = new SnapshotTimings(true);
		for (let i = 0; i < 5000; i++) timings.add("snapshot_total", i);
		const stat = timings.report().marks.snapshot_total;
		expect(stat.count).toBe(5000);
		expect(stat.p50).toBeGreaterThan(2048);
		expect(stat.p95).toBeLessThanOrEqual(4999);
	});

	it("retains samples for per-kind labels of an already-sampled mark", () => {
		const timings = new SnapshotTimings(true);
		for (let i = 1; i <= 5; i++) timings.add("snapshot_total:snapshot", i);
		timings.add("snapshot_total:snapshot_delta", 1);
		const marks = timings.report().marks;
		expect(marks["snapshot_total:snapshot"].p50).toBe(3);
		expect(marks["snapshot_total:snapshot"].p95).toBeCloseTo(4.8, 10);
		expect(marks["snapshot_total:snapshot_delta"].p50).toBe(1);
		expect(marks["snapshot_total:snapshot_delta"].count).toBe(1);
	});

	it("records one-message byte distributions per type", () => {
		const timings = new SnapshotTimings(true);
		timings.addBytes("snapshot", 1024);
		timings.addBytes("settings_state", 5620);
		const bytes = timings.report().bytes;
		expect(bytes["wire_bytes_p50:snapshot"]).toEqual({ count: 1, total: 1024, max: 1024, p50: 1024, p95: 1024 });
		expect(bytes["wire_bytes_p50:settings_state"].p50).toBe(5620);
		// Every non-core type also rolls into the permanent `other` bucket.
		expect(bytes["wire_bytes_p50:other"]).toEqual({ count: 1, total: 5620, max: 5620, p50: 5620, p95: 5620 });
	});

	it("never lets other message types crowd out the core snapshot slots", () => {
		const timings = new SnapshotTimings(true);
		for (let i = 0; i < 20; i++) timings.addBytes(`fake-${i}`, 10);
		timings.addBytes("snapshot", 1024);
		timings.addBytes("snapshot", 2048);
		const report = timings.report();
		// snapshot is reserved at construction, so it survives a full breakdown.
		expect(report.bytes["wire_bytes_p50:snapshot"]).toMatchObject({ count: 2, total: 3072, max: 2048 });
		// All 20 types still reach the bucket; only the breakdown is capped (16).
		expect(report.bytes["wire_bytes_p50:other"].count).toBe(20);
		expect(report.bytes["wire_bytes_p50:other"].total).toBe(200);
		expect(report.counters.bytes_name_dropped).toBe(4);
	});

	it("accumulates counters and clears them on reset", () => {
		const timings = new SnapshotTimings(true);
		timings.count("metadata_bytes", 100);
		timings.count("metadata_bytes", 24);
		timings.count("snapshot_kind:snapshot");
		expect(timings.report().counters).toEqual({ metadata_bytes: 124, "snapshot_kind:snapshot": 1 });
		timings.reset();
		expect(timings.report()).toEqual({ marks: {}, counters: {}, bytes: {} });
		timings.addBytes("snapshot", 512);
		expect(timings.report().bytes["wire_bytes_p50:snapshot"]).toMatchObject({ count: 1, total: 512 });
	});
});
