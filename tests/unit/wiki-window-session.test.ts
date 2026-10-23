import { afterEach, expect, it, vi } from "vitest";
import { WikiWindowSession, type LibraryConfig, type WikiWindowMemory, type WikiWindowObservation } from "../../web/src/wiki-window-session.js";
import type { ClientMessage } from "../../server/protocol.js";
afterEach(() => vi.useRealTimers());
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture(library = true, initial = "") {
	vi.useFakeTimers();
	const target = { cwd: initial || null, doc: null as string | null, client: "window", model: null as string | null, thinking: null as string | null };
	const current: WikiWindowObservation = { ready: true, switching: false, switchError: false, cwd: "/main", conversationId: "conv", sessionId: "session", wiki: true, opened: false, model: "p/model", models: [], thinking: "off", availableThinking: ["off", "high"] };
	let memory: WikiWindowMemory | null = null;
	const send = vi.fn<(message: ClientMessage) => boolean>(() => true);
	const configure = vi.fn<(action: "read" | "configure" | "remember", cwd?: string, path?: string | null) => Promise<LibraryConfig>>(async (_action, cwd) => ({ cwd: cwd ?? "/library", path: null, available: true }));
	const enter = vi.fn(async () => true), restore = vi.fn(), changeFolder = vi.fn(), warn = vi.fn();
	const session = new WikiWindowSession(library, true, {
		params: () => target, target: (cwd, path) => { target.cwd = cwd; target.doc = path; },
		readMemory: () => memory, writeMemory: value => { memory = value; }, configure, send, enter, restore, changeFolder, warn,
	});
	return { session, current, target, configure, send, enter, restore, changeFolder, setMemory: (value: WikiWindowMemory) => { memory = value; } };
}
it("loads configured target before switching, then opens only after authoritative cwd confirmation", async () => {
	const f = fixture(); f.session.connect(); f.session.observe(f.current);
	expect(f.send).not.toHaveBeenCalled(); await tick();
	expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: "set_cwd", path: "/library", source: "ui" });
	f.session.observe({ ...f.current, switching: true, cwd: "/library" });
	expect(f.enter).not.toHaveBeenCalled();
	f.session.observe({ ...f.current, cwd: "/library" });
	expect(f.enter).toHaveBeenCalledOnce();
});
it("an explicit selection supersedes a late configuration read", async () => {
	const f = fixture(); let complete!: (config: LibraryConfig) => void;
	f.configure.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
	f.session.connect(); f.session.observe(f.current);
	await f.session.chooseFolder("/chosen");
	complete({ cwd: "/old", path: "old.md", available: true }); await tick();
	expect(f.target.cwd).toBe("/chosen");
	expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: "set_cwd", path: "/chosen", source: "ui" });
});
it("closing suppresses a pending startup result", async () => {
	const f = fixture(); let complete!: (config: LibraryConfig) => void;
	f.configure.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
	const close = f.session.connect(); f.session.observe(f.current); close();
	complete({ cwd: "/old", path: null, available: true }); await tick();
	expect(f.send).not.toHaveBeenCalled(); expect(f.enter).not.toHaveBeenCalled();
});
it("a matching refresh restores the runtime, while a changed URL document cannot reuse stale memory", () => {
	for (const doc of ["one.md", "two.md"]) {
		const f = fixture(false, "/main"); f.target.doc = doc;
		f.setMemory({ client: "window", cwd: "/main", conversationId: "conv", sessionId: "session", path: "one.md", anchor: null });
		f.session.connect(); f.session.observe(f.current);
		expect(f.restore).toHaveBeenCalledTimes(doc === "one.md" ? 1 : 0);
		expect(f.enter).toHaveBeenCalledTimes(doc === "two.md" ? 1 : 0);
	}
});
it("model and thinking inheritance precede entry, with a bounded fallback", () => {
	const f = fixture(false, "/main"); f.target.model = "p/new"; f.target.thinking = "high";
	f.session.connect(); f.session.observe(f.current);
	expect(f.send).toHaveBeenLastCalledWith({ type: "set_model", modelId: "p/new" });
	f.session.observe({ ...f.current, model: "p/new" });
	expect(f.send).toHaveBeenLastCalledWith({ type: "set_thinking", level: "high" });
	expect(f.enter).not.toHaveBeenCalled();
	vi.advanceTimersByTime(5000);
	expect(f.enter).toHaveBeenCalledOnce();
});
it("missing folders and failed switches return to folder selection instead of entering a wrong chat", async () => {
	const f = fixture(); f.configure.mockResolvedValueOnce({ cwd: "/gone", path: null, available: false });
	f.session.connect(); f.session.observe(f.current); await tick();
	expect(f.session.getSnapshot()).toMatchObject({ ready: false, needsFolder: true, unavailable: true });
	await f.session.chooseFolder("/new"); f.session.observe({ ...f.current, switchError: true });
	expect(f.session.getSnapshot().needsFolder).toBe(true); expect(f.enter).not.toHaveBeenCalled();
});
it("existing windows use coordinated switching and commit configuration only after success", async () => {
	const f = fixture(true, "/main"); f.session.connect(); f.session.observe(f.current);
	await f.session.chooseFolder("/other");
	expect(f.changeFolder).toHaveBeenCalledWith("/other"); expect(f.configure).not.toHaveBeenCalled();
	f.configure.mockRejectedValueOnce(new Error("cannot persist"));
	expect(await f.session.folderOpened("/other")).toBe(false);
	expect(f.session.getSnapshot()).toMatchObject({ needsFolder: true, error: "cannot persist", saving: false });
	expect(await f.session.folderOpened("/other")).toBe(true);
});
