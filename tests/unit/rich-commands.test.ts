import { expect, it, vi } from "vitest";
import { RichCommands } from "../../web/src/rich-commands.js";
function fixture() {
	const calls: string[] = [];
	const editor = { editable: () => true, captureSelection: () => { calls.push("capture"); }, restoreSelection: () => { calls.push("restore"); return true; }, execute: vi.fn(() => { calls.push("execute"); }), insert: vi.fn(), color: vi.fn(() => "rgb(1, 2, 3)") };
	return { editor, calls, commands: new RichCommands(editor) };
}
it("the same command interface owns capture, restoration and execution ordering", () => {
	const { commands, calls } = fixture();
	expect(commands.execute("bold")).toBe(true);
	expect(calls).toEqual(["capture", "restore", "execute"]);
});
it("rejects unsupported choices and read-only edits before touching selection", () => {
	const { commands, editor, calls } = fixture();
	expect(commands.execute("font-size", "999px")).toBe(false);
	expect(commands.execute("text-align", "evil")).toBe(false);
	editor.editable = () => false;
	commands.prepare(); commands.insert("link");
	expect(commands.execute("bold")).toBe(false); expect(calls).toEqual([]);
});
it("resolves theme colors at execution and exposes one option catalogue to both adapters", () => {
	const { commands, editor } = fixture();
	expect(commands.describe("color").options?.map(option => option.value)).toEqual(["--text", "--accent", "--action", "--red"]);
	commands.execute("color", "--accent");
	expect(editor.color).toHaveBeenCalledWith("--accent");
	expect(editor.execute).toHaveBeenCalledWith("color", "rgb(1, 2, 3)");
});
it("a failed selection restore blocks both formatting and insertion", () => {
	const { commands, editor } = fixture(); editor.restoreSelection = () => false;
	expect(commands.execute("bold")).toBe(false); commands.insert("link");
	expect(editor.execute).not.toHaveBeenCalled(); expect(editor.insert).not.toHaveBeenCalled();
});
