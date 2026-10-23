import { useEffect, useRef } from "react";
import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { java } from "@codemirror/lang-java";
import { tags as t } from "@lezer/highlight";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { THEME_CHANGE_EVENT } from "../theme";

/**
 * The Playground scratch editor: CodeMirror 6 with Java syntax highlighting
 * and completion.
 *
 * Completion is deliberately word-level only — Java keywords plus identifiers
 * that already occur in the draft. There is no semantic engine behind it
 * (no JDT language server): typing `System.out.` suggests words from the
 * document, never real members of anything. That is the agreed scope.
 *
 * The theme is generated from the app's CSS variables and rebuilt on
 * THEME_CHANGE_EVENT, so the editor follows the appearance (light / graphite /
 * system) like every other surface.
 */

/** Java keywords and literals — the fixed half of the completion list. */
const KEYWORDS = [
	"abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
	"class", "const", "continue", "default", "do", "double", "else", "enum",
	"extends", "final", "finally", "float", "for", "goto", "if", "implements",
	"import", "instanceof", "int", "interface", "long", "native", "new",
	"package", "private", "protected", "public", "record", "return", "short",
	"static", "strictfp", "super", "switch", "synchronized", "this", "throw",
	"throws", "transient", "try", "var", "void", "volatile", "while",
	"true", "false", "null",
];

const KEYWORD_OPTIONS: Completion[] = KEYWORDS.map(label => ({ label, type: "keyword", boost: -10 }));

/**
 * Word-level completion: keywords plus every identifier that already occurs
 * in the draft. Triggers on typing a word (activateOnTyping) and after a `.`
 * (the agreed trigger), where the popup offers document words — never members.
 */
function completions(context: CompletionContext): { from: number; options: Completion[] } | null {
	// After a `.`: complete the (possibly empty) identifier that follows.
	const member = context.matchBefore(/\.[\w$]*$/);
	const word = member ?? context.matchBefore(/[\w$]+/);
	if (!word) return null;
	if (word.from === word.to && !context.explicit) return null;

	const from = member ? word.from + 1 : word.from;
	const current = word.text.replace(/^[.\s]+/, "");
	const seen = new Set<string>();
	const options: Completion[] = [];
	const add = (label: string, type: string) => {
		if (label === current || seen.has(label) || label.length < 2) return;
		seen.add(label);
		options.push({ label, type });
	};

	// Identifiers from the document come first — they are what the user just wrote.
	const doc = context.state.doc.toString();
	for (const match of doc.matchAll(/[A-Za-z_$][\w$]{1,}/g) ?? []) add(match[0], "variable");
	for (const option of KEYWORD_OPTIONS) {
		if (!seen.has(option.label)) options.push({ ...option });
	}
	return options.length ? { from, options } : null;
}

/** Build a CodeMirror theme from the app's CSS variables, like buildTermTheme. */
function buildEditorTheme(): Extension {
	const cs = getComputedStyle(document.documentElement);
	const v = (name: string) => cs.getPropertyValue(name).trim();
	// "dark" must match what the stylesheet actually applied, not the stored
	// preference: light/dark decided by luminance of the resolved background.
	const [r, g, b] = [0, 2, 4].map(i => parseInt(v("--bg").slice(1 + i * 2, 3 + i * 2), 16) || 0);
	const dark = 0.299 * r + 0.587 * g + 0.114 * b < 128;
	return EditorView.theme({
		"&": { backgroundColor: v("--output-bg"), color: v("--text") },
		".cm-content": { caretColor: v("--text") },
		".cm-cursor, .cm-dropCursor": { borderLeftColor: v("--text") },
		"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: v("--code-chip-bg") },
		".cm-gutters": { backgroundColor: v("--output-bg"), color: v("--text-faint"), border: "none" },
		".cm-activeLine": { backgroundColor: v("--row-hover") },
		".cm-activeLineGutter": { backgroundColor: v("--row-hover"), color: v("--text") },
		".cm-selectionMatch": { backgroundColor: v("--code-chip-bg") },
		".cm-tooltip": {
			backgroundColor: v("--bg-elev"),
			border: `1px solid ${v("--border")}`,
			borderRadius: v("--r-md"),
			color: v("--text"),
		},
		".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: v("--code-chip-bg"), color: v("--text") },
	}, { dark });
}

/** Syntax colors reuse the --code-* variables, so highlighted code matches the
 * highlight.js palette used by every other code block in the app. */
const highlightStyle = HighlightStyle.define([
	{ tag: t.keyword, color: "var(--code-keyword)" },
	{ tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
	{ tag: [t.number, t.bool, t.null], color: "var(--code-number)" },
	{ tag: [t.comment, t.lineComment, t.blockComment], color: "var(--code-comment)", fontStyle: "italic" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-title)" },
	{ tag: [t.typeName, t.className, t.namespace], color: "var(--code-title)" },
	{ tag: t.variableName, color: "var(--text)" },
]);

export function ScratchEditor({ value, onChange, onRun, onFormat, placeholder }: {
	value: string;
	onChange: (value: string) => void;
	/** ⌘/Ctrl+Enter always runs — the completion popup must not swallow it. */
	onRun: () => void;
	onFormat: () => void;
	placeholder: string;
}) {
	const holder = useRef<HTMLDivElement>(null);
	const runRef = useRef(onRun);
	runRef.current = onRun;
	const formatRef = useRef(onFormat);
	formatRef.current = onFormat;

	useEffect(() => {
		const theme = new Compartment();
		const view = new EditorView({
			parent: holder.current!,
			state: EditorState.create({
				doc: value,
				extensions: [
					basicSetup,
					java(),
					syntaxHighlighting(highlightStyle),
					autocompletion({ override: [completions] }),
					theme.of(buildEditorTheme()),
					cmPlaceholder(placeholder),
					Prec.highest(keymap.of([
						{
							key: "Mod-Enter",
							run: () => {
								runRef.current();
								return true;
							},
						},
						{ key: "Alt-Shift-f", run: () => { formatRef.current(); return true; } },
						indentWithTab,
					])),
					EditorView.updateListener.of(update => {
						if (update.docChanged) onChange(update.state.doc.toString());
					}),
				],
			}),
		});

		// Rebuild the theme when the app appearance changes; the CSS variables
		// have already been swapped by the time this event fires.
		const onThemeChange = () => {
			view.dispatch({ effects: theme.reconfigure(buildEditorTheme()) });
		};
		window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

		return () => {
			window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
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

	return <div className="scratch-editor-cm" ref={holder} aria-label="Java" />;
}
