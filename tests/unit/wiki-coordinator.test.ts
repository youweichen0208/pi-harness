import { afterEach, expect, it, vi } from "vitest";
import { WikiCoordinator } from "../../web/src/wiki-coordinator.js";
afterEach(() => vi.useRealTimers());
it("first operation owns admission; an old release cannot unlock a new operation", () => {
	const coordinator = new WikiCoordinator(), first = coordinator.begin()!;
	expect(coordinator.begin()).toBeNull(); first.release();
	const second = coordinator.begin()!; first.release();
	expect(second.current()).toBe(true); expect(first.current()).toBe(false);
	second.release(); expect(coordinator.busy()).toBe(false);
});
it("only a ready authoritative observation of the originating conversation settles", async () => {
	const coordinator = new WikiCoordinator(); coordinator.observe("c1", true, true);
	let finished = false; const pending = coordinator.waitSettled("c1").then(() => { finished = true; });
	coordinator.observe("c1", false, false); await Promise.resolve(); expect(finished).toBe(false);
	coordinator.observe("c1", false, true); await pending; expect(finished).toBe(true);
});
it("switching to a different idle conversation cannot satisfy interruption", async () => {
	const coordinator = new WikiCoordinator(); coordinator.observe("c1", true, true);
	const pending = expect(coordinator.waitSettled("c1")).rejects.toThrow(/changed/);
	coordinator.observe("c2", false, true); await pending;
});
it("timeout rejects rather than running the queued navigation", async () => {
	vi.useFakeTimers(); const coordinator = new WikiCoordinator(); coordinator.observe("c1", true, true);
	const navigate = vi.fn(); const pending = coordinator.waitSettled("c1").then(navigate);
	const rejected = expect(pending).rejects.toThrow(/timed out/);
	await vi.advanceTimersByTimeAsync(30000); await rejected; expect(navigate).not.toHaveBeenCalled();
	coordinator.observe("c1", false, true); expect(navigate).not.toHaveBeenCalled();
});

it("rejects a reused runtime ID after server restart and ignores expired operation results", async () => {
	const coordinator = new WikiCoordinator();
	const source = { cwd: "/work", conversationId: "c1", sessionId: "original" };
	const replacement = { ...source, sessionId: "replacement" };
	const operation = coordinator.begin()!;
	expect(operation.accepts(replacement, source)).toBe(false);
	expect(operation.accepts(replacement, source, replacement)).toBe(true);
	operation.release();
	expect(operation.accepts(source, source)).toBe(false);
	coordinator.observe("c1", true, true, "original");
	const pending = expect(coordinator.waitSettled("c1", 30000, "original")).rejects.toThrow(/changed/);
	coordinator.observe("c1", false, true, "replacement"); await pending;
});

it("waits through a provisional OMP identity when HTTP finishes before its snapshot", async () => {
	const coordinator = new WikiCoordinator(), operation = coordinator.begin()!;
	const source = { cwd: "/wiki", conversationId: "old", sessionId: "old-native" };
	coordinator.observe("old", false, true, "old-native");
	let finished = false;
	const pending = coordinator.waitForTarget({ conversationId: "new", sessionId: "new-native" }, source, operation).then(() => { finished = true; });
	coordinator.observe("new", true, true, "new"); await Promise.resolve(); expect(finished).toBe(false);
	coordinator.observe("new", false, false, "new-native"); await Promise.resolve(); expect(finished).toBe(false);
	coordinator.observe("new", false, true, "new-native"); await pending; expect(finished).toBe(true);
	operation.release();
});

it("refuses an unrelated conversation or an expired Wiki navigation while awaiting a snapshot", async () => {
	const coordinator = new WikiCoordinator(), source = { conversationId: "old", sessionId: "s" };
	coordinator.observe("old", false, true, "s");
	const first = coordinator.begin()!;
	const changed = expect(coordinator.waitForTarget({ conversationId: "new", sessionId: "next" }, source, first)).rejects.toThrow(/changed/);
	coordinator.observe("unrelated", false, true, "other"); await changed; first.release();
	coordinator.observe("old", false, true, "s");
	const second = coordinator.begin()!;
	const expired = expect(coordinator.waitForTarget({ conversationId: "new", sessionId: "next" }, source, second)).rejects.toThrow(/changed/);
	second.release(); await expired;
});

it("does not accept a wrong native identity after the target snapshot deadline", async () => {
	vi.useFakeTimers(); const coordinator = new WikiCoordinator(), operation = coordinator.begin()!;
	coordinator.observe("new", false, true, "wrong-native");
	const rejected = expect(coordinator.waitForTarget({ conversationId: "new", sessionId: "expected" }, { conversationId: "old" }, operation)).rejects.toThrow(/timed out/);
	await vi.advanceTimersByTimeAsync(5000); await rejected; operation.release();
});
