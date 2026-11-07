import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synchronizeSources } from "../../server/database/sync.js";
import { deleteConnection, getConnection, listConnections, restoreSource, saveConnection } from "../../server/database/store.js";
import * as sourceModule from "../../server/database/sources.js";
import { databaseAction, grantedConnections } from "../../server/database/service.js";
import { scanSources } from "../../server/database/sources.js";
import { startDatabaseSync } from "../../web/src/database-sync.js";
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-db-sync-")); dirs.push(dir); vi.stubEnv("PI_WEB_DATA_DIR", join(dir, "state"));
	mkdirSync(join(dir, ".dbeaver")); const path = join(dir, ".dbeaver/data-sources.json");
	const source = { path, kind: "dbeaver" as const };
	const write = (host = "localhost", driver = "postgres") => writeFileSync(path, JSON.stringify({ connections: { a: { name: "A", driver, configuration: { host, user: "reader", password: "source-password" } } } }));
	write(); return { dir, path, source, write, sync: () => synchronizeSources(dir, [source]) };
}
it("discovers project sources, reconciles changes without overwriting local passwords, and invalidates missing sources", () => {
	const f = fixture(); expect(scanSources(f.dir)).toContainEqual(f.source);
	expect(f.sync()).toEqual([]); const first = listConnections()[0];
	expect(getConnection(first.id).password).toBe("source-password");
	const saved = saveConnection({ ...first, password: "local-password" });
	f.sync(); expect(listConnections()[0].version).toBe(saved.version);
	f.write("new-host"); f.sync(); const changed = listConnections()[0];
	expect(changed).toMatchObject({ host: "new-host", needsTest: true }); expect(changed.version).not.toBe(saved.version);
	expect(getConnection(first.id).password).toBe("local-password");
	writeFileSync(f.path, '{"connections":{}}'); f.sync(); expect(() => getConnection(first.id)).toThrow(/missing/);
	const missing = listConnections()[0]; f.sync(); expect(listConnections()[0].version).toBe(missing.version);
	f.write(); f.sync(); expect(getConnection(first.id).password).toBe("local-password");
	rmSync(f.path); expect(synchronizeSources(f.dir, [])).toHaveLength(1); expect(() => getConnection(first.id)).toThrow(/unavailable/);
});
it("keeps deletion exclusions on disk and allows explicit manual restoration", () => {
	const f = fixture(); f.sync(); const saved = listConnections()[0];
	deleteConnection(saved.id, saved.version); f.sync(); expect(listConnections()).toEqual([]);
	restoreSource(saved.source!); f.sync(); expect(listConnections()).toHaveLength(1);
});
it("rejects malformed and unsupported sources without leaking contents or retaining usable stale settings", () => {
	const f = fixture(); f.sync(); const saved = listConnections()[0];
	writeFileSync(f.path, 'secret-marker malformed'); expect(JSON.stringify(f.sync())).not.toContain("secret-marker");
	expect(() => getConnection(saved.id)).toThrow(/unavailable/);
	f.write("localhost", "oracle"); expect(f.sync()).toHaveLength(1); expect(() => getConnection(saved.id)).toThrow(/Unsupported driver/);
	f.write(); f.sync(); expect(getConnection(saved.id).host).toBe("localhost");
});
it("does not follow uploaded source paths or alter manual connections", () => {
	const f = fixture(); const config = { name: "Manual", driver: "postgres" as const, host: "localhost", port: 5432, user: "u", db_name: "db" };
	const manual = saveConnection(config), upload = saveConnection(config, { kind: "dbeaver", path: "upload:data-sources.json", id: "a" });
	synchronizeSources(f.dir, []); expect(listConnections().map(c => c.version)).toEqual([manual.version, upload.version]);
});
it("polls, isolates stale mutation responses, times out and cleans up without cancelling foreground work", async () => {
	vi.useFakeTimers(); let revision = 0, busy = false;
	const receive = vi.fn(), error = vi.fn();
	const requests: { signal: AbortSignal; resolve: (v: number) => void }[] = [];
	const sync = startDatabaseSync({ request: signal => new Promise<number>(resolve => requests.push({ signal, resolve })), canStart: () => !busy, revision: () => revision, receive, error });
	expect(requests).toHaveLength(1); revision++; requests[0].resolve(1); await Promise.resolve(); expect(receive).not.toHaveBeenCalled();
	busy = true; await vi.advanceTimersByTimeAsync(15000); expect(requests).toHaveLength(1);
	busy = false; void sync.refresh();
	expect(requests).toHaveLength(2); await vi.advanceTimersByTimeAsync(10000); expect(requests[1].signal.aborted).toBe(true); expect(error).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(5000); expect(requests).toHaveLength(3);
	requests[1].resolve(2); requests[2].resolve(3); await Promise.resolve(); expect(receive).toHaveBeenCalledWith(3); expect(receive).not.toHaveBeenCalledWith(2);
	void sync.refresh(); sync.stop(); expect(requests.at(-1)!.signal.aborted).toBe(true);
	requests.at(-1)!.resolve(4); await vi.advanceTimersByTimeAsync(30000); expect(receive).not.toHaveBeenCalledWith(4); expect(requests).toHaveLength(4);
});

it("automatic sync invalidates grants while unchanged sync keeps them, and agents cannot start discovery", async () => {
	const f = fixture(); vi.spyOn(sourceModule, "scanSources").mockReturnValue([f.source]);
	await databaseAction("sync-owner", f.dir, "sync", { action: "sync" }); const saved = listConnections()[0];
	await databaseAction("sync-owner", f.dir, "grant", { action: "grant", ids: [saved.id], versions: { [saved.id]: saved.version } });
	await databaseAction("sync-owner", f.dir, "sync", { action: "sync" }); expect(grantedConnections("sync-owner")).toHaveLength(1);
	f.write("changed"); await databaseAction("sync-owner", f.dir, "sync", { action: "sync" }); expect(grantedConnections("sync-owner")).toHaveLength(0);
	await expect(databaseAction("sync-owner", f.dir, "sync", { action: "sync" }, undefined, true)).rejects.toThrow(/Unsupported agent/);
});
