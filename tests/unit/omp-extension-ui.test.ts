import { describe, expect, it } from "vitest";
import { OmpExtensionUi } from "../../server/omp/extension-ui.js";
import type { ServerMessage } from "../../server/protocol.js";
import type { OmpFrame } from "../../server/omp/transport.js";

function fixture() {
	const messages: ServerMessage[] = [], replies: OmpFrame[] = [];
	const ui = new OmpExtensionUi(message => messages.push(message));
	const observe = (conversationId: string, generation: string, frame: OmpFrame) => ui.observe({ conversationId, generation, sequence: 1, frame: { id: "native", ...frame } });
	const dialog = () => { const result = messages.findLast(message => message.type === "dialog"); if (!result || result.type !== "dialog") throw Error("Missing dialog"); return result; };
	return { ui, observe, messages, replies, dialog };
}

describe("native extension UI ownership", () => {
	it("preserves select presentation metadata without leaking arbitrary option fields", () => {
		const { observe, dialog } = fixture();
		observe("a", "a1", { type: "extension_ui_request", method: "select", options: ["one", "two", "Done"], optionDetails: [{ description: "Explain one", private: "omit" }], initialIndex: 1, selectionMarker: "checkbox", checkedIndices: [0, 0, -1, 9, "1"], markableCount: 2 });
		expect(dialog()).toMatchObject({ initialIndex: 1, selectionMarker: "checkbox", checkedIndices: [0], markableCount: 2, optionDetails: [{ description: "Explain one" }, {}, {}] });
		observe("a", "a1", { id: "secret", type: "extension_ui_request", method: "input", secret: true });
		expect(dialog().secret).toBe(true);
	});
	it("carries a native multi-question ask without reducing it to a select dialog", () => {
		const { observe, dialog } = fixture();
		const questions = [{ id: "first", question: "Choose", options: [{ label: "A", description: "Details", preview: "Preview" }], recommended: 0 }, { id: "second", question: "Anything else?", options: [], multi: true }];
		observe("a", "a1", { type: "extension_ui_request", method: "ask", questions });
		expect(dialog()).toMatchObject({ kind: "ask", questions });
	});
	it("rejects reordered, unknown, duplicate and single-select mixed answers without consuming the ask", () => {
		const { ui, observe, dialog, replies } = fixture();
		const questions = [{ id: "a", question: "Single", options: [{ label: "one" }, { label: "two" }] }, { id: "b", question: "Multi", options: [{ label: "three" }], multi: true }];
		observe("a", "a1", { type: "extension_ui_request", method: "ask", questions });
		const response = { type: "dialog_response", conversationId: "a", id: dialog().id } as const;
		const valid = [{ id: "a", selectedOptions: ["two"] }, { id: "b", selectedOptions: ["three"], customInput: " extra " }];
		for (const value of [[], [...valid].reverse(), [{ id: "a", selectedOptions: ["unknown"] }, valid[1]], [{ id: "a", selectedOptions: ["one", "one"] }, valid[1]], [{ id: "a", selectedOptions: ["one", "two"] }, valid[1]], [{ id: "a", selectedOptions: ["one"], customInput: "mixed" }, valid[1]]]) {
			expect(() => ui.reply({ ...response, value }, "a", "a1", frame => replies.push(frame))).toThrow();
		}
		expect(replies).toEqual([]);
		ui.reply({ ...response, value: valid }, "a", "a1", frame => replies.push(frame));
		expect(replies).toEqual([{ type: "extension_ui_response", id: "native", answers: [valid[0], { ...valid[1], customInput: "extra" }] }]);
		expect(() => ui.reply({ ...response, value: valid }, "a", "a1", () => {})).toThrow();
	});
	it("separates identical native IDs across workers and refuses wrong owners, types and duplicate responses", () => {
		const { ui, observe, messages, replies, dialog } = fixture();
		observe("a", "a1", { type: "extension_ui_request", method: "confirm", title: "A" }); const a = dialog();
		observe("b", "b1", { type: "extension_ui_request", method: "confirm", title: "B" }); const b = dialog();
		expect(a.id).not.toBe(b.id); expect(a.id).not.toBe("native");
		const response = { type: "dialog_response", conversationId: "a", id: a.id, value: true } as const;
		expect(() => ui.reply(response, "b", "b1", frame => replies.push(frame))).toThrow();
		expect(() => ui.reply({ ...response, conversationId: "b" }, "b", "b1", frame => replies.push(frame))).toThrow();
		expect(() => ui.reply({ ...response, value: "true" }, "a", "a1", frame => replies.push(frame))).toThrow();
		expect(replies).toEqual([]); expect(messages.filter(message => message.type === "dialog_closed")).toEqual([]);
		ui.reply(response, "a", "a1", frame => replies.push(frame));
		expect(replies).toEqual([{ type: "extension_ui_response", id: "native", confirmed: true }]);
		expect(() => ui.reply(response, "a", "a1", frame => replies.push(frame))).toThrow();
	});

	it("expires dialogs on worker replacement, preserves sibling state and never replays notifications or editor writes", () => {
		const { ui, observe, messages, dialog } = fixture();
		for (const id of ["a", "b"]) {
			observe(id, id + "1", { type: "extension_ui_request", method: "setWidget", widgetKey: "same", widgetLines: [id] });
			observe(id, id + "1", { type: "extension_ui_request", method: "confirm", title: id });
		}
		const b = dialog();
		observe("a", "a1", { type: "extension_ui_request", method: "notify", message: "once", notifyType: "warning" });
		observe("a", "a1", { type: "extension_ui_request", method: "set_editor_text", text: "once" });
		ui.synchronize("a", undefined);
		expect(messages.some(message => message.type === "extension_ui_reset" && message.conversationId === "a")).toBe(true);
		const replay: ServerMessage[] = []; ui.replay("a", message => replay.push(message)); ui.replay("b", message => replay.push(message));
		expect(replay.filter(message => message.type === "dialog")).toEqual([b]);
		expect(replay.some(message => message.type === "notice" || message.type === "extension_editor")).toBe(false);
		expect(replay.some(message => message.type === "widgets" && message.conversationId === "b" && message.widgets[0].lines[0] === "b")).toBe(true);
		observe("b", "b2", { type: "extension_ui_request", method: "confirm", title: "new" });
		expect(dialog().id).not.toBe(b.id);
		expect(() => ui.reply({ type: "dialog_response", conversationId: "b", id: b.id, value: false }, "b", "b2", () => {})).toThrow();
	});

	it("validates choices and typed cancellation, and closes only the matching native timeout request", () => {
		const { ui, observe, replies, dialog } = fixture();
		observe("a", "a1", { type: "extension_ui_request", method: "select", options: ["one", "two"] }); const select = dialog();
		expect(() => ui.reply({ type: "dialog_response", conversationId: "a", id: select.id, value: "three" }, "a", "a1", frame => replies.push(frame))).toThrow();
		ui.reply({ type: "dialog_response", conversationId: "a", id: select.id, value: null }, "a", "a1", frame => replies.push(frame));
		expect(replies).toEqual([{ type: "extension_ui_response", id: "native", cancelled: true }]);
		observe("a", "a1", { type: "extension_ui_request", method: "input" }); const input = dialog();
		observe("a", "a1", { type: "extension_ui_request", method: "cancel", targetId: "native" });
		expect(() => ui.reply({ type: "dialog_response", conversationId: "a", id: input.id, value: "late" }, "a", "a1", frame => replies.push(frame))).toThrow();
		expect(replies).toHaveLength(1);
	});
});
