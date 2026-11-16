import { randomUUID } from "node:crypto";
import type { ClientMessage, ServerMessage, UiAskQuestion, UiAskAnswer } from "../protocol.js";
import { isRecord } from "./framing.js";
import type { OmpEnvelope, OmpFrame } from "./transport.js";

type Sink = (message: ServerMessage) => void;
type Dialog = Extract<ServerMessage, { type: "dialog" }>;
type State = { generation: string; dialogs: Map<string, Dialog>; widgets: Map<string, string[]>; statuses: Map<string, string>; title?: string };

function askQuestions(value: unknown): UiAskQuestion[] {
	if (!Array.isArray(value)) throw Error("Invalid native ask questions");
	return value.map(question => {
		if (!isRecord(question) || typeof question.id !== "string" || typeof question.question !== "string" || !Array.isArray(question.options)) throw Error("Invalid native ask question");
		return { id: question.id, question: question.question,
			...(typeof question.header === "string" ? { header: question.header } : {}),
			...(typeof question.multi === "boolean" ? { multi: question.multi } : {}),
			...(Number.isInteger(question.recommended) ? { recommended: question.recommended as number } : {}),
			options: question.options.map(option => {
				if (!isRecord(option) || typeof option.label !== "string") throw Error("Invalid native ask option");
				return { label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}), ...(typeof option.preview === "string" ? { preview: option.preview } : {}) };
			}),
		};
	});
}

/** Match the native validator, rejecting forged or reordered replies before resolving a request. */
function askAnswers(value: unknown, questions: UiAskQuestion[] | undefined): UiAskAnswer[] {
	if (!questions || !Array.isArray(value) || value.length !== questions.length) throw Error("Invalid ask response");
	return questions.map((question, index) => {
		const answer = value[index];
		if (!isRecord(answer) || answer.id !== question.id || !Array.isArray(answer.selectedOptions)
			|| answer.selectedOptions.some(label => typeof label !== "string" || !question.options.some(option => option.label === label))
			|| new Set(answer.selectedOptions).size !== answer.selectedOptions.length
			|| answer.customInput !== undefined && typeof answer.customInput !== "string") throw Error("Invalid ask response");
		const customInput = typeof answer.customInput === "string" ? answer.customInput.trim() : undefined;
		if (!question.multi && (answer.selectedOptions.length > 1 || answer.selectedOptions.length > 0 && customInput)) throw Error("Invalid single-choice response");
		return { id: question.id, selectedOptions: answer.selectedOptions, ...(customInput ? { customInput } : {}) };
	});
}

/** Transient native UI belongs to one conversation and one worker lifetime.
 * Browser IDs are independent of the SDK's per-process request IDs. */
export class OmpExtensionUi {
	private states = new Map<string, State>();
	constructor(private emit: Sink) {}

	synchronize(conversationId: string, generation: string | undefined) {
		const state = this.states.get(conversationId);
		if (!state || state.generation === generation) return;
		this.states.delete(conversationId);
		for (const dialog of state.dialogs.values()) this.emit({ type: "dialog_closed", conversationId, id: dialog.id });
		this.emit({ type: "extension_ui_reset", conversationId });
	}

	observe({ conversationId, generation, frame }: OmpEnvelope) {
		if (frame.type !== "extension_ui_request" || typeof frame.id !== "string") return;
		this.synchronize(conversationId, generation);
		let state = this.states.get(conversationId);
		if (!state) { state = { generation, dialogs: new Map(), widgets: new Map(), statuses: new Map() }; this.states.set(conversationId, state); }
		if (frame.method === "ask") {
			if (state.dialogs.has(frame.id)) return;
			const questions = askQuestions(frame.questions);
			const dialog: Dialog = { type: "dialog", conversationId, source: "OMP", id: randomUUID(), kind: "ask", title: questions[0]?.header ?? questions[0]?.question ?? "", questions, args: [],
				...(typeof frame.timeout === "number" && Number.isFinite(frame.timeout) && frame.timeout > 0 ? { timeoutMs: frame.timeout } : {}) };
			state.dialogs.set(frame.id, dialog); this.emit(dialog);
		} else if (frame.method === "select" || frame.method === "confirm" || frame.method === "input" || frame.method === "editor") {
			if (state.dialogs.has(frame.id)) return;
			const dialog: Dialog = { type: "dialog", conversationId, source: "OMP", id: randomUUID(), kind: frame.method, title: String(frame.title ?? ""), args: [frame.method === "select" ? frame.options : frame.method === "confirm" ? frame.message : frame.method === "editor" ? frame.prefill : frame.placeholder] };
			if (frame.method === "select" && Array.isArray(frame.options)) {
				const count = frame.options.length;
				const index = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < count;
				if (Array.isArray(frame.optionDetails)) dialog.optionDetails = frame.options.map((_, i) => {
					const detail = (frame.optionDetails as unknown[])[i];
					return isRecord(detail) && typeof detail.description === "string" ? { description: detail.description } : {};
				});
				if (index(frame.initialIndex)) dialog.initialIndex = frame.initialIndex;
				if (frame.selectionMarker === "radio" || frame.selectionMarker === "checkbox") dialog.selectionMarker = frame.selectionMarker;
				if (Array.isArray(frame.checkedIndices)) dialog.checkedIndices = [...new Set(frame.checkedIndices.filter(index))];
				if (typeof frame.markableCount === "number" && Number.isInteger(frame.markableCount) && frame.markableCount >= 0 && frame.markableCount <= count) dialog.markableCount = frame.markableCount;
			}
			if (frame.method === "input" && frame.secret === true) dialog.secret = true;
			state.dialogs.set(frame.id, dialog); this.emit(dialog);
		} else if (frame.method === "cancel" && typeof frame.targetId === "string") {
			const dialog = state.dialogs.get(frame.targetId);
			if (dialog) { state.dialogs.delete(frame.targetId); this.emit({ type: "dialog_closed", conversationId, id: dialog.id }); }
		} else if (frame.method === "notify") {
			this.emit({ type: "notice", conversationId, level: frame.notifyType === "error" || frame.notifyType === "warning" ? frame.notifyType : "info", text: String(frame.message ?? "") });
		} else if (frame.method === "set_editor_text") {
			this.emit({ type: "extension_editor", conversationId, id: randomUUID(), text: String(frame.text ?? "") });
		} else if (frame.method === "setWidget" && typeof frame.widgetKey === "string") {
			if (frame.widgetLines === undefined) state.widgets.delete(frame.widgetKey);
			else if (Array.isArray(frame.widgetLines) && frame.widgetLines.every(line => typeof line === "string")) state.widgets.set(frame.widgetKey, frame.widgetLines);
			else return;
			this.emit({ type: "widgets", conversationId, widgets: [...state.widgets].map(([key, lines]) => ({ key, lines })) });
		} else if (frame.method === "setStatus" && typeof frame.statusKey === "string") {
			if (frame.statusText === undefined) state.statuses.delete(frame.statusKey);
			else if (typeof frame.statusText === "string") state.statuses.set(frame.statusKey, frame.statusText);
			else return;
			this.emit({ type: "statuses", conversationId, statuses: [...state.statuses].map(([key, text]) => ({ key, text })) });
		} else if (frame.method === "setTitle" && typeof frame.title === "string") {
			state.title = frame.title; this.emit({ type: "extension_title", conversationId, title: frame.title });
		}
	}

	reply(message: Extract<ClientMessage, { type: "dialog_response" }>, activeId: string, generation: string | undefined, send: (frame: OmpFrame) => void) {
		if (message.conversationId !== activeId || !generation) throw Error("Dialog no longer active");
		const state = this.states.get(activeId);
		const entry = state?.generation === generation ? [...state.dialogs].find(([, dialog]) => dialog.id === message.id) : undefined;
		if (!state || !entry) throw Error("Dialog no longer active");
		const [nativeId, dialog] = entry, value = message.value;
		const answers = value !== null && dialog.kind === "ask" ? askAnswers(value, dialog.questions) : undefined;
		if (value !== null && dialog.kind !== "ask" && (dialog.kind === "confirm" ? typeof value !== "boolean" : typeof value !== "string" || dialog.kind === "select" && (!Array.isArray(dialog.args[0]) || !dialog.args[0].includes(value)))) throw Error("Invalid dialog response");
		send({ type: "extension_ui_response", id: nativeId, ...(value === null ? { cancelled: true } : answers ? { answers } : dialog.kind === "confirm" ? { confirmed: value } : { value }) });
		state.dialogs.delete(nativeId); this.emit({ type: "dialog_closed", conversationId: activeId, id: dialog.id });
	}

	replay(conversationId: string, sink: Sink) {
		sink({ type: "extension_ui_reset", conversationId });
		const state = this.states.get(conversationId); if (!state) return;
		sink({ type: "widgets", conversationId, widgets: [...state.widgets].map(([key, lines]) => ({ key, lines })) });
		sink({ type: "statuses", conversationId, statuses: [...state.statuses].map(([key, text]) => ({ key, text })) });
		if (state.title !== undefined) sink({ type: "extension_title", conversationId, title: state.title });
		for (const dialog of state.dialogs.values()) sink(dialog);
	}
}
