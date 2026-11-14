import { playgroundMinimap } from "../playground-minimap";
import { useT } from "../i18n";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { pythonLanguageSupport } from "../playground-python-language";
import { acceptCompletion } from "@codemirror/autocomplete";
import { indentWithTab, isolateHistory, toggleComment } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { tags as t } from "@lezer/highlight";
import { HighlightStyle, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { Compartment, EditorState, Prec, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, placeholder as cmPlaceholder, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { THEME_CHANGE_EVENT } from "../theme";

export const PLAYGROUND_TAB_SIZE = 4;

/**
 * Build a CodeMirror theme from the Playground's own --pg-code-* tokens.
 *
 * The editor deliberately does not reuse the app's --bg/--code-* variables: the
 * Playground reads like a printed code page (soft paper, recessed gutter, hairline
 * indentation rails), which the shared chat code-island palette cannot express.
 * Tokens live in styles.css next to `.scratch-page`.
 */
function buildEditorTheme(surface: HTMLElement): Extension {
	const cs = getComputedStyle(surface);
	const v = (name: string) => cs.getPropertyValue(name).trim();
	// "dark" must match what the stylesheet actually applied, not the stored
	// preference: light/dark decided by luminance of the resolved background.
	const [r, g, b] = [0, 2, 4].map(i => parseInt(v("--bg").slice(1 + i * 2, 3 + i * 2), 16) || 0);
	const dark = 0.299 * r + 0.587 * g + 0.114 * b < 128;
	const paper = v("--pg-code-bg") || v("--bg-elev");
	const ink = v("--pg-code-fg") || v("--text");
	return EditorView.theme({
		"&": { backgroundColor: paper, color: ink },
		// CodeMirror measures layout from these declarations; the stylesheet's
		// .cm-scroller rule must agree or the caret drifts from the glyphs.
		".cm-scroller": { fontFamily: v("--pg-font"), tabSize: String(PLAYGROUND_TAB_SIZE) },
		".cm-content": { caretColor: ink, padding: "0" },
		".cm-cursor, .cm-dropCursor": { borderLeftColor: ink },
		"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: v("--pg-code-chip") },
		".cm-selectionMatch": { backgroundColor: v("--pg-code-chip") },
		// Keep the active line subtle and continuous with the reference code surface.
		".cm-activeLine": { backgroundColor: v("--pg-code-active-line") },
		".cm-tooltip": {
			backgroundColor: v("--bg-elev"),
			border: `1px solid ${v("--border")}`,
			borderRadius: v("--r-md"),
			color: v("--text"),
			shadow: "var(--card-shadow)",
		},
		".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: v("--accent-soft"), color: v("--accent") },
	}, { dark });
}

/** Syntax colors come from the reference sheet: purple keywords, navy strings,
 * teal types, green numbers, violet call names, grey italic comments. */
const highlightStyle = HighlightStyle.define([
	{ tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.self], color: "var(--pg-code-kw)" },
	{ tag: [t.string, t.special(t.string), t.docString], color: "var(--pg-code-str)" },
	{ tag: [t.number, t.atom], color: "var(--pg-code-num)" },
	{ tag: [t.comment, t.lineComment, t.blockComment], color: "var(--pg-code-comment)", fontStyle: "italic" },
	{ tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.function(t.propertyName)], color: "var(--pg-code-fn)" },
	{ tag: [t.standard(t.variableName), t.standard(t.propertyName), t.special(t.variableName)], color: "var(--pg-code-builtin)" },
	{ tag: [t.typeName, t.className, t.namespace], color: "var(--pg-code-builtin)" },
	// `__name__` and friends arrive as t.heading from the Python parser, not as a
	// name tag; unstyled they would inherit the app's bold heading rule.
	{ tag: [t.definition(t.variableName), t.local(t.variableName), t.heading], color: "var(--pg-code-fg)" },
	{ tag: t.variableName, color: "var(--pg-code-fg)" },
	{ tag: [t.operator, t.punctuation, t.separator], color: "var(--pg-code-fg)" },
	{ tag: t.definitionKeyword, color: "var(--pg-code-definition)" },
	{ tag: [t.paren, t.bracket, t.brace, t.bool, t.null], color: "var(--pg-code-bracket)" },
	{ tag: [t.meta, t.processingInstruction], color: "var(--pg-code-comment)" },
	{ tag: t.invalid, color: "var(--red)" },
]);

function railDecorations(view: EditorView): DecorationSet {
	const doc = view.state.doc;
	const marks: Range<Decoration>[] = [];
	// Python indents with spaces only, so the leading whitespace width is the block
	// depth. A blank line owns no indent of its own; it borrows the next statement's
	// depth so a gap inside a block keeps the rail continuous, exactly like a guide.
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		let depth = /^\s*/.exec(line.text)![0].length;
		if (!line.text.trim()) {
			depth = 0;
			for (let next = n + 1; next <= doc.lines; next++) {
				const text = doc.line(next).text;
				if (!text.trim()) continue;
				depth = /^\s*/.exec(text)![0].length;
				break;
			}
		}
		if (depth < 4) continue;
		marks.push(Decoration.line({ class: "cm-indent-rail", attributes: { style: `--rail-depth:${Math.floor(depth / 4)}` } }).range(line.from));
	}
	return Decoration.set(marks);
}

const indentRails = ViewPlugin.fromClass(class {
	decorations: DecorationSet;
	constructor(view: EditorView) { this.decorations = railDecorations(view); }
	update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = railDecorations(update.view); }
}, { decorations: plugin => plugin.decorations });

function toggleEditorComment(view: EditorView): boolean {
	return toggleComment({ state: view.state, dispatch: transaction => view.dispatch({
		changes: transaction.changes, selection: transaction.selection, effects: transaction.effects,
		annotations: isolateHistory.of("full"),
	}) });
}

export interface ScratchEditorHandle {
	toggleComment(): void;
	applyProposal(base: string, code: string): boolean;
	indentRange(): { fromLine: number; toLine: number };
	applyIndent(source: string, result: string): void;
}

export const ScratchEditor = forwardRef<ScratchEditorHandle, {
	value: string;
	onChange: (value: string) => void;
	onCursorChange: (position: { line: number; column: number }) => void;
	/** ⌘/Ctrl+Enter always runs — the completion popup must not swallow it. */
	onRun: () => void;
	onFormat: () => void;
	onSave: () => void;
	onLanguageStatus: (state: "loading" | "ready" | "error", reason?: string) => void;
	placeholder: string;
}>(function ScratchEditor({ value, onChange, onRun, onFormat, onSave, onLanguageStatus, onCursorChange, placeholder }, ref) {
	const t = useT();
	const editor = useRef<EditorView | null>(null);
	useImperativeHandle(ref, () => ({
		applyProposal(base, code) {
			const view = editor.current;
			if (!view || view.state.doc.toString() !== base) return false;
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code }, annotations: isolateHistory.of("full"), userEvent: "input" });
			return true;
		},
		toggleComment() { if (editor.current) { toggleEditorComment(editor.current); editor.current.focus(); } },
		indentRange() {
			const state = editor.current?.state;
			if (!state) return { fromLine: 1, toLine: 1 };
			const { from, to, empty } = state.selection.main;
			return empty ? { fromLine: 1, toLine: state.doc.lines } : { fromLine: state.doc.lineAt(from).number, toLine: state.doc.lineAt(Math.max(from, to - 1)).number };
		},
		applyIndent(source, result) {
			const view = editor.current;
			if (!view || view.state.doc.toString() !== source) return;
			const lines = result.split("\n");
			if (lines.length !== view.state.doc.lines) return;
			const changes = [];
			for (let n = 1; n <= lines.length; n++) {
				const line = view.state.doc.line(n);
				const before = /^\s*/.exec(line.text)![0], after = /^\s*/.exec(lines[n - 1])![0];
				if (line.text.slice(before.length) !== lines[n - 1].slice(after.length)) return;
				if (before !== after) changes.push({ from: line.from, to: line.from + before.length, insert: after });
			}
			view.dispatch({ changes, annotations: isolateHistory.of("full"), userEvent: "input.indent" });
			view.focus();
		},
	}), []);
	const holder = useRef<HTMLDivElement>(null);
	const cursorRef = useRef(onCursorChange);
	cursorRef.current = onCursorChange;
	const runRef = useRef(onRun);
	runRef.current = onRun;
	const formatRef = useRef(onFormat);
	formatRef.current = onFormat;
	const saveRef = useRef(onSave);
	saveRef.current = onSave;

	useEffect(() => {
		const theme = new Compartment();
		const view = new EditorView({
			parent: holder.current!,
			state: EditorState.create({
				doc: value,
				extensions: [
					basicSetup,
					python(),
					indentUnit.of(" ".repeat(PLAYGROUND_TAB_SIZE)),
					EditorState.tabSize.of(PLAYGROUND_TAB_SIZE),
					syntaxHighlighting(highlightStyle),
					indentRails,
					playgroundMinimap(t("pgMinimap")),
					EditorView.contentAttributes.of({ spellcheck: "false" }),
					pythonLanguageSupport(onLanguageStatus),
					theme.of(buildEditorTheme(holder.current!)),
					cmPlaceholder(placeholder),
					Prec.highest(keymap.of([
						{
							key: "Mod-Enter",
							run: () => {
								runRef.current();
								return true;
							},
						},
						{ key: "Mod-/", run: toggleEditorComment },
						{ key: "Mod-s", run: () => { saveRef.current(); return true; } },
						{ key: "Alt-Shift-f", run: () => { formatRef.current(); return true; } },
						{ key: "Tab", run: acceptCompletion },
						indentWithTab,
					])),
					EditorView.updateListener.of(update => {
						if (update.docChanged) onChange(update.state.doc.toString());
						if (update.docChanged || update.selectionSet) {
							const head = update.state.selection.main.head;
							const line = update.state.doc.lineAt(head);
							cursorRef.current({ line: line.number, column: head - line.from + 1 });
						}
					}),
				],
			}),
		});

		editor.current = view;

		// Rebuild the theme when the app appearance changes; the CSS variables
		// have already been swapped by the time this event fires.
		const onThemeChange = () => {
			view.dispatch({ effects: theme.reconfigure(buildEditorTheme(holder.current!)) });
		};
		window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

		return () => {
			window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
			editor.current = null;
			view.destroy();
		};
		// The editor is created once; external value changes are synced below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// External value changes (the first-visit template seed) — never while the
	// user is typing, because typing itself is what produces parent updates.
	useEffect(() => {
		if (holder.current?.querySelector(".cm-editor")) {
			const view = EditorView.findFromDOM(holder.current);
			if (view && view.state.doc.toString() !== value) {
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
			}
		}
	}, [value]);

	return <div className="scratch-editor-cm" ref={holder} aria-label="Python" />;
});
