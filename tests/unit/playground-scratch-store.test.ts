import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlaygroundScratchStore, EMPTY_SCRATCH_TESTS, SCRATCH_EXAMPLE, type ScratchDraft, type ScratchTransport } from "../../web/src/playground-scratch-store.js";
import type { PlaygroundScratch } from "../../server/protocol.js";

function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const draft = (content: string): ScratchDraft => ({ content, tests: { ...EMPTY_SCRATCH_TESTS } });
function fixture() {
	let stored: PlaygroundScratch = { ...draft("original"), updatedAt: 1 };
	const transport: ScratchTransport = {
		read: vi.fn(async () => structuredClone(stored)),
		write: vi.fn(async value => { stored = { ...structuredClone(value), updatedAt: Date.now() }; }),
	};
	const store = new PlaygroundScratchStore(transport);
	return { store, transport, stored: () => stored };
}
const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("loads existing drafts and debounces code and cases as one payload", async () => {
	const { store, transport, stored } = fixture();
	const leave = store.connect(); await settle();
	expect(store.getSnapshot().doc?.content).toBe("original");
	store.edit(draft("first")); await vi.advanceTimersByTimeAsync(500);
	store.edit(draft("second")); await vi.advanceTimersByTimeAsync(599);
	expect(transport.write).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(stored().content).toBe("second");
	expect(store.getSnapshot().saveState).toBe("saved");
	leave();
});

it("serializes a revert during an in-flight write and never calls the old baseline saved", async () => {
	const { store, transport } = fixture(); store.connect(); await settle();
	const first = deferred<void>(); vi.mocked(transport.write).mockImplementationOnce(() => first.promise);
	store.edit(draft("changed")); const writing = store.flush(); await settle();
	store.edit(draft("original")); const reverting = store.flush(); await settle();
	expect(transport.write).toHaveBeenCalledTimes(1);
	expect(store.getSnapshot().saveState).not.toBe("saved");
	first.resolve(); await writing; await reverting;
	expect(vi.mocked(transport.write).mock.calls.map(([value]) => value.content)).toEqual(["changed", "original"]);
	expect(store.getSnapshot().saveState).toBe("saved");
});

it("flushes on unmount and waits for confirmation before re-entry reads", async () => {
	const { store, transport } = fixture(); const leave = store.connect(); await settle();
	const first = deferred<void>();
	vi.mocked(transport.write).mockImplementationOnce(() => first.promise);
	vi.mocked(transport.read).mockResolvedValueOnce({ ...draft("leaving"), updatedAt: 2 });
	store.edit(draft("leaving")); leave(); await settle();
	const reconnect = store.connect(); await settle();
	expect(transport.read).toHaveBeenCalledTimes(1);
	first.resolve(); await settle();
	expect(transport.read).toHaveBeenCalledTimes(2);
	reconnect();
});

it("keeps a failed draft on re-entry and lets later edits recover", async () => {
	const { store, transport, stored } = fixture(); const leave = store.connect(); await settle();
	vi.mocked(transport.write).mockRejectedValueOnce(new Error("offline"));
	store.edit(draft("unsaved")); leave(); await settle(); store.connect(); await settle();
	expect(store.getSnapshot()).toMatchObject({ doc: { content: "unsaved" }, saveState: "error" });
	expect(transport.read).toHaveBeenCalledTimes(1);
	store.edit(draft("recovered")); await vi.advanceTimersByTimeAsync(600);
	expect(stored().content).toBe("recovered");
	expect(store.getSnapshot().saveState).toBe("saved");
});

it("ignores a stale load from an abandoned mount", async () => {
	const { store, transport } = fixture(); const old = deferred<PlaygroundScratch>();
	vi.mocked(transport.read).mockReturnValueOnce(old.promise);
	const leave = store.connect(); await settle(); leave(); store.connect(); await settle();
	store.edit(draft("new mount")); old.resolve({ ...draft("old response"), updatedAt: 1 }); await settle();
	expect(store.getSnapshot().doc?.content).toBe("new mount");
});

it("does not overwrite newer input with a refresh started on re-entry", async () => {
	const { store, transport } = fixture(); const leave = store.connect(); await settle(); leave();
	const refresh = deferred<PlaygroundScratch>(); vi.mocked(transport.read).mockReturnValueOnce(refresh.promise);
	store.connect(); await settle(); store.edit(draft("typed during refresh"));
	refresh.resolve({ ...draft("server"), updatedAt: 2 }); await settle();
	expect(store.getSnapshot().doc?.content).toBe("typed during refresh");
});

it("initializes first-use and legacy tests, but a failed read never writes a template", async () => {
	const { store, transport } = fixture();
	vi.mocked(transport.read).mockRejectedValueOnce(new Error("unavailable"));
	const leave = store.connect(); await vi.advanceTimersByTimeAsync(1000);
	expect(store.getSnapshot()).toMatchObject({ doc: null, loadFailed: true });
	expect(transport.write).not.toHaveBeenCalled(); leave();
	vi.mocked(transport.read).mockResolvedValueOnce({ content: "", updatedAt: 0 });
	store.connect(); await vi.advanceTimersByTimeAsync(600);
	expect(store.getSnapshot().doc?.content).toBe(SCRATCH_EXAMPLE);
	expect(transport.write).toHaveBeenCalledWith(draft(SCRATCH_EXAMPLE));
});

it("old failures do not replace newer pending or saved status", async () => {
	const { store, transport } = fixture(); store.connect(); await settle();
	const first = deferred<void>(); vi.mocked(transport.write).mockReturnValueOnce(first.promise);
	store.edit(draft("first")); const a = store.flush(); await settle();
	store.edit(draft("second")); const b = store.flush();
	first.reject(new Error("offline")); expect(await a).toBe(false); expect(await b).toBe(true);
	expect(store.getSnapshot()).toMatchObject({ doc: { content: "second" }, saveState: "saved" });
});

it("normalizes legacy program drafts and persists their cases without replacing code", async () => {
	const { store, transport } = fixture();
	vi.mocked(transport.read).mockResolvedValueOnce({ content: "legacy", tests: { ...EMPTY_SCRATCH_TESTS, mode: "program", selectedMethod: "Main#f()", casesByMethod: { "Main#f()": [{ id: "one", args: [] }] } }, updatedAt: 1 });
	store.connect(); await vi.advanceTimersByTimeAsync(600);
	expect(transport.write).toHaveBeenCalledWith({ content: "legacy", tests: { mode: "methods", selectedMethod: "Main#f()", casesByMethod: { "Main#f()": [{ id: "one", args: [] }] } } });
});

it("retries the same failed payload explicitly without an endless background retry", async () => {
	const { store, transport } = fixture(); store.connect(); await settle();
	vi.mocked(transport.write).mockRejectedValueOnce(new Error("offline"));
	store.edit(draft("retry")); expect(await store.flush()).toBe(false);
	await vi.advanceTimersByTimeAsync(60000);
	expect(transport.write).toHaveBeenCalledTimes(1);
	expect(await store.flush()).toBe(true);
	expect(store.getSnapshot().saveState).toBe("saved");
});
