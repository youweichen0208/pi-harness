import { useEffect, useRef } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { acceptCompletion, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { databaseCompletions, databaseCompletionRange, type DatabaseTable } from "../database-completion";
import { useT } from "../i18n";

export function DatabaseSqlEditor({ value, onChange, onRun, tables, mysql }: { value: string; onChange: (value: string) => void; onRun: () => void; tables: DatabaseTable[]; mysql: boolean }) {
	const t = useT(), holder = useRef<HTMLDivElement>(null), editor = useRef<EditorView>();
	const latest = useRef({ onChange, onRun, tables, mysql }); latest.current = { onChange, onRun, tables, mysql };
	useEffect(() => {
		const view = new EditorView({ parent: holder.current!, state: EditorState.create({ doc: value, extensions: [
			lineNumbers(), history(), EditorView.lineWrapping,
			EditorView.contentAttributes.of({ "aria-label": t("dbSql"), "aria-describedby": "database-sql-help" }),
			Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { latest.current.onRun(); return true; } }, { key: "Tab", run: acceptCompletion }])),
			keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
			autocompletion({ override: [context => {
				const word = databaseCompletionRange(context.state.sliceDoc(0, context.pos));
				if (!word || (!word.prefix && !context.explicit)) return null;
				const prefix = word.prefix.toLocaleLowerCase();
				return { from: word.from, filter: false, options: databaseCompletions(latest.current.tables, latest.current.mysql).filter(item => item.label.toLocaleLowerCase().includes(prefix)).slice(0, 100) };
			}] }),
			EditorView.updateListener.of(update => { if (update.docChanged) latest.current.onChange(update.state.doc.toString()); }),
		] }) });
		editor.current = view;
		return () => { view.destroy(); editor.current = undefined; };
	}, [t]);
	useEffect(() => { const view = editor.current; if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }, [value]);
	return <div className="database-sql-editor" ref={holder} />;
}
