import { expect, it } from "vitest";
import { OmpRecovery, ageRecovery } from "../../server/omp/recovery.js";

it("checks current operation IDs beside the native cancellation target", () => {
	const tracker = new OmpRecovery(() => {});
	let compactions = 0, retries = 0;
	const target = { abortCompaction() { compactions++; }, abortRetry() { retries++; } };
	tracker.observe({ type: "manual_compaction_start" });
	const old = tracker.snapshot().compaction!.id;
	tracker.observe({ type: "auto_compaction_end", action: "shake", aborted: true, willRetry: false, result: undefined });
	expect(tracker.snapshot().compaction?.id).toBe(old);
	tracker.observe({ type: "manual_compaction_end", aborted: true });
	tracker.observe({ type: "auto_compaction_start", reason: "idle", action: "shake" });
	expect(tracker.cancel(old, target)).toBe(false);
	tracker.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "SECRET_KEY" });
	expect(tracker.cancel(tracker.snapshot().retry!.id, target)).toBe(true);
	expect(compactions).toBe(0); expect(retries).toBe(1);
	tracker.observe({ type: "auto_retry_end", success: false, attempt: 1 });
	expect(tracker.snapshot().compaction?.reason).toBe("idle");
	expect(tracker.cancel(tracker.snapshot().compaction!.id, target)).toBe(true);
	expect(compactions).toBe(1);
});

it("samples durations, preserves skipped outcomes and excludes raw provider errors", () => {
	let now = 100;
	const tracker = new OmpRecovery(() => {}, () => now);
	tracker.observe({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 5000, errorMessage: "https://provider?token=SECRET" });
	now += 1250;
	const snapshot = tracker.snapshot();
	expect(snapshot.retry?.remainingMs).toBe(3750);
	expect(ageRecovery(snapshot, 2000)?.retry?.remainingMs).toBe(1750);
	expect(JSON.stringify(snapshot)).not.toMatch(/SECRET|deadline/);
	tracker.observe({ type: "manual_compaction_start" });
	tracker.observe({ type: "manual_compaction_end", aborted: false, skipped: true, errorMessage: "Nothing to compact" });
	expect(tracker.snapshot().lastCompaction?.status).toBe("skipped");
	expect(tracker.snapshot().retry?.attempt).toBe(2);
	tracker.observe({ type: "auto_retry_end", success: true, attempt: 2 });
	expect(tracker.snapshot().retry).toBeUndefined();
});
