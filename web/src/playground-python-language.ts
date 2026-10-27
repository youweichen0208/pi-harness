import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { setDiagnostics } from "@codemirror/lint";
import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, showTooltip, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { withToken } from "./auth-token";
import { randomUuid } from "./uuid";
import type { PythonLanguageResult } from "./types";

const signatureEffect = StateEffect.define<Tooltip | null>();
const signatureField = StateField.define<Tooltip | null>({
	create: () => null,
	update(value, tr) { if (tr.docChanged || tr.selection) value = null; for (const e of tr.effects) if (e.is(signatureEffect)) value = e.value; return value; },
	provide: field => showTooltip.from(field),
});

/** One isolated language document per editor mount; stale responses never edit newer text. */
export function pythonLanguageSupport(onStatus: (state: "loading" | "ready" | "error", reason?: string) => void) {
	const id = randomUuid();
	let closed = false;
	const controllers = new Set<AbortController>();
	async function request(code: string, offset: number, action: string): Promise<PythonLanguageResult> {
		const controller = new AbortController(); controllers.add(controller);
		const timer = setTimeout(() => controller.abort(), 90_000);
		try {
			const response = await fetch(withToken("/api/playground/language"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, code, offset, action }), signal: controller.signal });
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || "Python language service unavailable");
			if (!closed) onStatus("ready"); return data;
		} catch (error) { if (!closed) onStatus("error", error instanceof Error ? error.message : String(error)); throw error; }
		finally { clearTimeout(timer); controllers.delete(controller); }
	}
	const completions = async (context: CompletionContext) => {
		const word = context.matchBefore(/[\w$]*$/);
		if (!context.explicit && !word?.text && context.state.sliceDoc(context.pos - 1, context.pos) !== ".") return null;
		const code = context.state.doc.toString();
		try {
			const result = await request(code, context.pos, "completion");
			if (closed || context.aborted) return null;
			return { from: word?.from ?? context.pos, options: (result.items ?? []).map(item => ({
				label: item.label, detail: item.detail?.endsWith(item.label) ? undefined : item.detail, info: item.info, type: item.kind === 2 || item.kind === 3 ? "function" : item.kind === 7 ? "class" : "variable",
				apply(view: EditorView) {
					if (view.state.doc.toString() !== code) return;
					const edits = [item.edit, ...item.additionalEdits].sort((a, b) => a.from - b.from || a.to - b.to);
					if (edits.some((e, i) => e.from < 0 || e.to > code.length || e.to < e.from || i > 0 && edits[i - 1].to > e.from)) return;
					const before = item.additionalEdits.filter(e => e.to <= item.edit.from).reduce((n, e) => n + e.text.length - (e.to - e.from), 0);
					view.dispatch({ changes: edits.map(e => ({ from: e.from, to: e.to, insert: e.text })), selection: { anchor: item.edit.from + item.edit.text.length + before }, userEvent: "input.complete" });
				},
			})) };
		} catch { return null; }
	};
	return [signatureField, autocompletion({ override: [completions] }), ViewPlugin.fromClass(class {
		private timer: ReturnType<typeof setTimeout> | undefined;
		private revision = 0;
		private busy = false;
		private retry = () => { onStatus("loading"); this.revision++; this.schedule(); };
		constructor(private view: EditorView) { onStatus("loading"); this.schedule(); window.addEventListener("pi-harness:python-tools-installed", this.retry); }
		update(update: ViewUpdate) { if (update.docChanged || update.selectionSet) { this.revision++; this.schedule(); } }
		private schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => void this.analyze(), 700); }
		private async analyze() {
			if (closed) return;
			if (this.busy) { this.schedule(); return; }
			this.busy = true;
			const revision = this.revision, code = this.view.state.doc.toString(), pos = this.view.state.selection.main.head;
			try {
				const result = await request(code, pos, "diagnostics");
				if (closed || revision !== this.revision) return;
				this.view.dispatch(setDiagnostics(this.view.state, result.diagnostics ?? []));
				if (/\([^;{}]*$/.test(code.slice(0, pos))) {
					const result = await request(code, pos, "signature");
					if (closed || revision !== this.revision) return;
					const labels = result.signatures ?? [];
					this.view.dispatch({ effects: signatureEffect.of(labels.length ? { pos, above: true, create() { const dom = document.createElement("div"); dom.className = "scratch-signature"; dom.textContent = labels.slice(0, 5).join("\n"); return { dom }; } } : null) });
				}
			} catch { /* Visible status explains unavailable service. No word-list fallback. */ }
			finally { this.busy = false; }
		}
		destroy() {
			window.removeEventListener("pi-harness:python-tools-installed", this.retry);
			closed = true; clearTimeout(this.timer); for (const controller of controllers) controller.abort();
			void fetch(withToken("/api/playground/language"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "close" }), keepalive: true }).catch(() => {});
		}
	})];
}
