import { afterEach, expect, it, vi } from "vitest";
import { FileDocument } from "../../web/src/file-document.js";
import type { ClientMessage, ServerMessage } from "../../server/protocol.js";
afterEach(() => vi.useRealTimers());
function fixture(autoSave = false) {
	vi.useFakeTimers();
	const sent: ClientMessage[] = [];
	const file = { cwd: "/work", path: "doc.md", name: "doc.md" };
	const document = new FileDocument(file, msg => { sent.push(msg); return true; }, autoSave);
	const close = document.connect();
	const request = () => sent.at(-1) as Extract<ClientMessage, { type: "read_file" | "write_file" }>;
	const content = (text: string, version: string, requestId = request().requestId): Extract<ServerMessage, { type: "file_content" }> => ({ type: "file_content", ...file, kind: "text", text, version, requestId, binary: false, truncated: false, size: text.length, lines: 1 });
	document.receiveContent(content("initial", "v1"));
	const reply = (ok = true, extra = {}) => document.receiveResult({ type: "file_result", ...file, operation: "write", requestId: request().requestId, ok, version: "v2", ...extra });
	return { document, sent, close, request, content, reply };
}
it("publishes the confirmed disk version before a send reads its frozen snapshot", () => {
	const { document, reply } = fixture();
	document.edit("edited");
	let snapshot;
	expect(document.saveContext(document.id, () => { snapshot = document.readContext(document.id); })).toBe(true);
	expect(snapshot).toBeUndefined();
	reply();
	expect(snapshot).toMatchObject({ editorSnapshot: { text: "edited", version: "v2", dirty: false } });
});
it("serializes auto-save and close; an additional send is rejected rather than duplicated", () => {
	const { document, sent, reply } = fixture(true);
	document.edit("edited"); vi.advanceTimersByTime(800);
	const leave = vi.fn(), send = vi.fn();
	document.guard(leave);
	expect(document.saveContext(document.id, send)).toBe(false);
	expect(sent.filter(m => m.type === "write_file")).toHaveLength(1);
	reply();
	expect(leave).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
});
it("a conflict retains the draft and blocks continuation until explicit retry succeeds", () => {
	const { document, reply } = fixture();
	const next = vi.fn();
	document.edit("local"); document.saveContext(document.id, next);
	reply(false, { conflict: true, error: "changed" });
	expect(document.getSnapshot()).toMatchObject({ draft: "local", status: "failed", conflict: true });
	expect(next).not.toHaveBeenCalled();
	document.guard(next);
	expect(document.getSnapshot().leave).toBe(true);
	document.resolveLeave("cancel");
	expect(next).not.toHaveBeenCalled();
	document.save(true, next); reply();
	expect(next).toHaveBeenCalledOnce();
});
it("timeouts and disconnects reject late acknowledgements without changing the baseline", () => {
	const { document, reply } = fixture();
	const next = vi.fn();
	document.edit("local"); document.save(false, next); vi.advanceTimersByTime(15000); reply();
	expect(document.getSnapshot().loaded?.text).toBe("initial");
	expect(document.getSnapshot().status).toBe("failed"); expect(next).not.toHaveBeenCalled();
	document.save(false, next); document.observe(false, false); reply();
	expect(next).not.toHaveBeenCalled();
});
it("external changes reload clean files but preserve dirty drafts and old request isolation", () => {
	const { document, content } = fixture();
	document.externalChanged(); document.receiveContent(content("remote", "v2"));
	expect(document.getSnapshot().draft).toBe("remote");
	document.edit("local"); document.externalChanged(); document.receiveContent(content("new remote", "v3"));
	expect(document.getSnapshot()).toMatchObject({ draft: "local", remoteText: "new remote" });
	document.receiveContent(content("stale", "v0", "unknown"));
	expect(document.getSnapshot().draft).toBe("local");
});
it("closing invalidates callbacks, requests and autosave timers", () => {
	const { document, sent, reply, close } = fixture(true);
	const next = vi.fn();
	document.edit("local"); document.save(false, next); close(); reply(); vi.runAllTimers();
	expect(next).not.toHaveBeenCalled();
	expect(sent.filter(m => m.type === "write_file")).toHaveLength(1);
});

it("rechecks external changes observed while a save acknowledgement was pending", () => {
	const { document, sent, reply, content } = fixture();
	document.edit("local"); document.save();
	document.externalChanged();
	expect(sent.filter(m => m.type === "read_file")).toHaveLength(1);
	reply();
	expect(sent.filter(m => m.type === "read_file")).toHaveLength(2);
	document.receiveContent(content("external after write", "v3"));
	expect(document.getSnapshot().draft).toBe("external after write");
});
it("disabled and disposed files cannot supply a current-file snapshot", () => {
	const { document, close } = fixture();
	document.observe(true, true);
	expect(document.context).toBeNull(); expect(document.readContext(document.id)).toBeNull();
	document.observe(true, false);
	expect(document.context).not.toBeNull();
	close(); expect(document.readContext(document.id)).toBeNull();
});
