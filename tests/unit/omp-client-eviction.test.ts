import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OmpChatService, OmpClientSession } from "../../server/omp/chat-service.js";

// Exercise service ownership/timers deterministically; the companion /ws test
// uses real OMP workers, held model streams and real PTYs for idle eligibility.
let root: string;
let service: OmpChatService | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-idle-ownership-"));
	vi.useFakeTimers(); vi.stubEnv("PI_WEB_CLIENT_IDLE_MINUTES", "0.01");
	vi.spyOn(OmpClientSession.prototype, "initialize").mockResolvedValue();
	vi.spyOn(OmpClientSession.prototype, "canEvict", "get").mockImplementation(function (this: OmpClientSession) { return !this.connected; });
	vi.spyOn(OmpClientSession.prototype, "dispose").mockResolvedValue();
});
afterEach(async () => {
	try { await service?.disposeAll(); }
	finally { service = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
});
const start = () => service = new OmpChatService(root, join(root, "client-state.json"));
const sink = () => {};

it("waits for retirement before recreating a client and shares the new initialization", async () => {
	const host = start(), old = await host.attach("client", sink);
	let release!: () => void;
	const close = vi.spyOn(old, "dispose").mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
	host.detach("client", sink);
	await vi.advanceTimersByTimeAsync(1200);
	expect(close).toHaveBeenCalledTimes(1); expect(host.get("client")).toBeUndefined();
	let attached = false;
	const first = host.attach("client", sink).then(client => { attached = true; return client; });
	const second = host.attach("client", () => {});
	await vi.advanceTimersByTimeAsync(1200);
	expect(attached).toBe(false); expect(close).toHaveBeenCalledTimes(1);
	release();
	const next = await first;
	expect(await second).toBe(next); expect(next).not.toBe(old);
	expect(host.serviceStatus().clientSessions).toBe(1);
});

it("does not open another history worker after cleanup fails", async () => {
	const host = start(), old = await host.attach("client", sink);
	const close = vi.spyOn(old, "dispose").mockRejectedValueOnce(Error("cleanup failed"));
	vi.spyOn(console, "error").mockImplementation(() => {});
	host.detach("client", sink); await vi.advanceTimersByTimeAsync(1200);
	await expect(host.attach("client", sink)).rejects.toThrow("cleanup failed");
	await vi.advanceTimersByTimeAsync(1200);
	expect(close).toHaveBeenCalledTimes(1);
	expect(host.get("client")).toBeUndefined();
});

it("zero disables eviction and shutdown prevents new attachment", async () => {
	vi.stubEnv("PI_WEB_CLIENT_IDLE_MINUTES", "0");
	const host = start(), client = await host.attach("client", sink);
	host.detach("client", sink); await vi.advanceTimersByTimeAsync(3_600_000);
	expect(host.get("client")).toBe(client);
	await host.disposeAll();
	await expect(host.attach("client", sink)).rejects.toThrow("Service draining");
});

it("activity between timer ticks restarts the idle window", async () => {
	const host = start(), client = await host.attach("client", sink);
	host.detach("client", sink); await vi.advanceTimersByTimeAsync(850);
	client.lastActivityAt = Date.now();
	await vi.advanceTimersByTimeAsync(500);
	expect(host.get("client")).toBe(client);
	await vi.advanceTimersByTimeAsync(500);
	expect(host.get("client")).toBeUndefined();
});

it("never retires initialization even if its socket has already disconnected", async () => {
	let release!: () => void;
	vi.mocked(OmpClientSession.prototype.initialize).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
	const host = start(), opening = host.attach("client", sink);
	host.detach("client", sink); await vi.advanceTimersByTimeAsync(1200);
	expect(OmpClientSession.prototype.dispose).not.toHaveBeenCalled();
	release(); await opening;
	// The /ws closed callback removes the late attachment after initialization.
	host.detach("client", sink); await vi.advanceTimersByTimeAsync(1200);
	expect(OmpClientSession.prototype.dispose).toHaveBeenCalledTimes(1);
});
