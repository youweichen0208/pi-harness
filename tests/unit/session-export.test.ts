import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionExportService, type SessionExportLimits } from "../../server/session-export.js";

const roots: string[] = [];
const services: SessionExportService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(limits?: Partial<SessionExportLimits>) {
	const root = mkdtempSync(join(tmpdir(), "pi-session-export-unit-")); roots.push(root);
	const service = new SessionExportService(root, { sourceBytes: 1024, entries: 10, outputBytes: 1024, ttlMs: 1000, ...limits }); services.push(service);
	const manager = SessionManager.inMemory(root);
	const session = {
		sessionId: "session-one",
		sessionFile: join(root, "source.jsonl"),
		sessionManager: manager,
		exportToHtml: async (path: string) => { writeFileSync(path, "<html>full tree</html>"); return path; },
		exportToJsonl: (path: string) => { writeFileSync(path, '{"type":"message"}\n'); return path; },
	} as unknown as AgentSession;
	return { root, service, session };
}

describe("session export downloads", () => {
	it("binds a single-use token to client, conversation and session, then cleans the file", async () => {
		const { root, service, session } = fixture();
		const download = await service.create("client", "conversation", session, "html", () => true);
		expect(readFileSync(download.path, "utf8")).toContain("full tree");
		if (process.platform !== "win32") {
			expect(statSync(download.path).mode & 0o777).toBe(0o600);
			expect(statSync(join(root, "exports")).mode & 0o777).toBe(0o700);
		}
		expect(service.consume("other", "conversation", "session-one", download.token, () => true)).toBeUndefined();
		expect(service.consume("client", "other", "session-one", download.token, () => true)).toBeUndefined();
		expect(service.consume("client", "conversation", "other", download.token, () => true)).toBeUndefined();
		const first = service.consume("client", "conversation", "session-one", download.token, () => true);
		const replay = service.consume("client", "conversation", "session-one", download.token, () => true);
		expect(first?.path).toBe(download.path); expect(replay).toBeUndefined();
		await service.finish(download.token);
		expect(existsSync(download.path)).toBe(false);
	});

	it("expires undownloaded files and invalidates replaced conversations", async () => {
		const { service, session } = fixture({ ttlMs: 15 });
		const expired = await service.create("client", "conversation", session, "jsonl", () => true);
		await sleep(35);
		expect(service.consume("client", "conversation", "session-one", expired.token, () => true)).toBeUndefined();
		expect(existsSync(expired.path)).toBe(false);
		const invalidated = await service.create("client", "conversation", session, "html", () => true);
		await service.invalidate("conversation");
		expect(service.consume("client", "conversation", "session-one", invalidated.token, () => true)).toBeUndefined();
		expect(existsSync(invalidated.path)).toBe(false);
	});

	it("enforces preflight entry/source limits and final output limits without leftovers", async () => {
		const { root, service, session } = fixture({ entries: 0 });
		Object.defineProperty(session.sessionManager, "getEntries", { value: () => [{}] });
		await expect(service.create("client", "conversation", session, "html", () => true)).rejects.toThrow(/too many entries/);
		const entriesService = new SessionExportService(root, { sourceBytes: 4, entries: 10, outputBytes: 1024, ttlMs: 1000 }); services.push(entriesService);
		writeFileSync(session.sessionFile!, "12345");
		await expect(entriesService.create("client", "conversation", session, "html", () => true)).rejects.toThrow(/too large/);
		const outputService = new SessionExportService(root, { sourceBytes: 1024, entries: 10, outputBytes: 2, ttlMs: 1000 }); services.push(outputService);
		await expect(outputService.create("client", "conversation", session, "html", () => true)).rejects.toThrow(/too large/);
		expect(existsSync(join(root, "exports"))).toBe(true);
		expect(readFileSync(session.sessionFile!, "utf8")).toBe("12345");
	});

	it("allows only one preparation per client and revalidates ownership after rendering", async () => {
		const { service, session } = fixture();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let owned = true;
		session.exportToHtml = async (path: string) => { await gate; writeFileSync(path, "done"); return path; };
		const pending = service.create("client", "conversation", session, "html", () => owned);
		await sleep(1);
		await expect(service.create("client", "conversation", session, "html", () => true)).rejects.toThrow(/already being prepared/);
		owned = false; release();
		await expect(pending).rejects.toThrow(/unavailable/);
	});
});
