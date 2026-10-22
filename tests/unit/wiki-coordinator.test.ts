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
