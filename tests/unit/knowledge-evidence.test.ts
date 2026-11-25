import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FilesService } from "../../server/files-service.js";
import { branchEvidence, KNOWLEDGE_EVIDENCE_ENTRY } from "../../server/knowledge-evidence.js";
import type { KnowledgeEvidence } from "../../server/knowledge-requests.js";
import type { ServerMessage } from "../../server/protocol.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "knowledge-preview-"));
	roots.push(cwd);
	const root = join(cwd, "source");
	mkdirSync(root);
	const text = Array.from({ length: 6300 }, (_, i) => `内容 ${i + 1}`).join("\r\n") + "\r\n";
	writeFileSync(join(root, "deep.md"), text);
	const evidence: KnowledgeEvidence = {
		id: "ev_" + "a".repeat(32), requestId: "original", conversationId: "c1", requestCwd: cwd, scopeSourceIds: ["s"],
		source: { id: "s", root, name: "source", kind: "knowledge" },
		path: "deep.md", startLine: 6020, endLine: 6021, fingerprint: createHash("sha256").update(text).digest("hex"), workingTree: "unknown",
	};
	const messages: ServerMessage[] = [];
	let lookups = 0, revokeOnLookup = Infinity;
	const service = new FilesService({ getCwd: () => cwd, getActiveCwd: () => cwd, isDisposed: () => false, emit: message => messages.push(message),
		resolveEvidence: (owner, project, id) => ++lookups < revokeOnLookup && owner === "c1" && project === cwd && id === evidence.id ? { evidence, root } : undefined });
	const request = { conversationId: "c1", cwd, evidenceId: evidence.id, requestId: "preview" };
	return { cwd, root, text, evidence, messages, service, request, revokeDuringRead: () => { revokeOnLookup = lookups + 2; } };
}

it("locates only branch-owned citations after the native session is reopened", () => {
	const { cwd, evidence } = fixture();
	const manager = SessionManager.create(cwd, cwd);
	const initial = manager.appendMessage({ role: "user", content: "/ask", timestamp: Date.now() });
	manager.appendCustomEntry(KNOWLEDGE_EVIDENCE_ENTRY, { sessionId: manager.getSessionId(), evidence });
	for (let i = 0; i < 257; i++) {
		manager.appendCustomEntry(KNOWLEDGE_EVIDENCE_ENTRY, { sessionId: manager.getSessionId(), evidence: { ...evidence, id: "ev_" + i.toString(16).padStart(32, "0") } });
	}
	const reopened = SessionManager.open(manager.getSessionFile()!, cwd);
	const parents = vi.spyOn(reopened, "getEntry");
	expect(branchEvidence(reopened, "restored", evidence.id)).toEqual({ ...evidence, conversationId: "restored" });
	expect(parents.mock.calls.length).toBeGreaterThan(256);
	parents.mockClear();
	expect(branchEvidence(reopened, "restored", evidence.id)?.id).toBe(evidence.id);
	expect(parents).not.toHaveBeenCalled();
	reopened.branch(initial);
	expect(branchEvidence(reopened, "restored", evidence.id)).toBeUndefined();
});

it("serves a bounded window around the verified range using the original byte size and lines", async () => {
	const f = fixture();
	await f.service.readFile("ignored-client-path.md", f.request);
	const content = f.messages.at(-1);
	if (content?.type !== "file_content") throw new Error("missing preview");
	expect(content).toMatchObject({ evidence: { id: f.evidence.id, sourceId: "s", requestId: "original" }, requestId: "preview", cwd: f.cwd,
		conversationId: "c1", path: "deep.md", startLine: 5980, lines: 120, size: Buffer.byteLength(f.text), truncated: true });
	expect(content.text.split("\n")[40]).toBe("内容 6020");
	expect(content.evidence).not.toHaveProperty("root");
	await f.service.readFile("deep.md", { ...f.request, line: 1 });
	expect(f.messages.at(-1)).toMatchObject({ type: "file_result", errorCode: "evidence_unavailable" });
});

it("rejects revoked, foreign and stale evidence without a fallback read", async () => {
	const f = fixture();
	for (const options of [{ ...f.request, conversationId: "another" }, { ...f.request, evidenceId: "" }, { ...f.request, cwd: f.root }]) {
		await f.service.readFile("deep.md", options);
		expect(f.messages.at(-1)).toMatchObject({ type: "file_result", errorCode: "evidence_unavailable", ok: false, ...options });
	}
	writeFileSync(join(f.root, "deep.md"), "changed");
	await f.service.readFile("deep.md", f.request);
	expect(f.messages.at(-1)).toMatchObject({ type: "file_result", errorCode: "stale_evidence", evidenceId: f.evidence.id });
	f.revokeDuringRead();
	await f.service.readFile("deep.md", f.request);
	expect(f.messages.at(-1)).toMatchObject({ type: "file_result", errorCode: "evidence_unavailable" });
});
