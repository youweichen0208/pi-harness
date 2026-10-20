import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { FONT_SIZES, LINE_HEIGHTS } from "../rich-content";
export function RichFormattingToolbar({ compact, disabled, prepare, run, insert, painter }: {
	compact: boolean; disabled: boolean; prepare: () => void; run: (command: string, value?: string) => void; insert: (id: string) => void; painter: boolean;
}) {
	const t = useT(); const [more, setMore] = useState(!compact && window.innerWidth > 700);
	useEffect(() => {
		const narrow = matchMedia("(max-width: 700px)");
		const changed = () => { if (narrow.matches) setMore(false); };
		narrow.addEventListener("change", changed); return () => narrow.removeEventListener("change", changed);
	}, []);
	const button = (label: Parameters<typeof t>[0], command: string, text?: string, value?: string) => <button type="button" disabled={disabled} title={t(label)} aria-label={t(label)} aria-pressed={command === "paint" ? painter : undefined} onMouseDown={e => { e.preventDefault(); prepare(); }} onClick={() => run(command, value)}>{text ?? t(label)}</button>;
	return <div className="rich-format-tools" role="toolbar" aria-label={t("richFormatToolbar")}>
		{button("richUndo", "undo", "↶")}{button("richRedo", "redo", "↷")}
		<select aria-label={t("richParagraph")} disabled={disabled} defaultValue="" onFocus={prepare} onChange={e => { run("formatBlock", e.target.value); e.target.value = ""; }}><option value="" disabled>{t("richParagraph")}</option><option value="p">{t("richParagraph")}</option>{[1,2,3,4,5,6].map(n => <option key={n} value={`h${n}`}>H{n}</option>)}</select>
		{button("richBold", "bold", "B")}{button("richItalic", "italic", "I")}
		{button("richList", "insertUnorderedList", "• ≡")}{button("richTaskList", "task", "☑")}
		<select aria-label={t("richBlocksGroup")} disabled={disabled} defaultValue="" onFocus={prepare} onChange={e => { insert(e.target.value); e.target.value = ""; }}><option value="" disabled>＋ {t("richInsertMenu")}</option>{([['tip','richGreenBlock'],['glk','richBlueBlock'],['warning','richYellowBlock'],['collapse','richCollapse'],['tp','richImage'],['link','wikiAddLink'],['card','richLinkCard']] as const).map(([id,label]) => <option key={id} value={id}>{t(label)}</option>)}</select>
		<button type="button" aria-expanded={more} onClick={() => setMore(!more)}>{t("richMore")}</button>
		{more && <div className="rich-format-more">
			{button("richPainter", "paint")}{button("richClearFormat", "clear")}
			<select aria-label={t("richFontSize")} defaultValue="15" disabled={disabled} onFocus={prepare} onChange={e => run("font-size", `${e.target.value}px`)}>{FONT_SIZES.map(n => <option key={n} value={n}>{n}px</option>)}</select>
			{button("richUnderline", "underline", "U")}{button("richStrike", "strikeThrough", "S̶")}{button("richSuperscript", "superscript", "x²")}{button("richSubscript", "subscript", "x₂")}
			<select aria-label={t("richTextColor")} defaultValue="" disabled={disabled} onFocus={prepare} onChange={e => { run("color", getComputedStyle(document.documentElement).getPropertyValue(e.target.value).trim()); e.target.value = ""; }}><option value="" disabled>{t("richTextColor")}</option>{([['--text','richDefaultColor'],['--accent','richColorBlue'],['--action','richColorGreen'],['--red','richColorRed']] as const).map(([v,k]) => <option key={v} value={v}>{t(k)}</option>)}</select>
			<select aria-label={t("richTextHighlight")} defaultValue="" disabled={disabled} onFocus={prepare} onChange={e => { run("highlight", e.target.value); e.target.value = ""; }}><option value="" disabled>{t("richTextHighlight")}</option>{(['yellow','green','blue','pink','purple'] as const).map(color => <option key={color} value={color}>{t(`richHighlight_${color}`)}</option>)}<option value="clear">{t("richHighlightClear")}</option></select>
			<select aria-label={t("richAlignment")} defaultValue="" disabled={disabled} onFocus={prepare} onChange={e => { run("text-align", e.target.value); e.target.value = ""; }}><option value="" disabled>{t("richAlignment")}</option>{(['left','center','right','justify'] as const).map(value => <option key={value} value={value}>{t(`richAlign_${value}`)}</option>)}</select>
			<select aria-label={t("richLineHeight")} defaultValue="1.74" disabled={disabled} onFocus={prepare} onChange={e => run("line-height", e.target.value)}>{LINE_HEIGHTS.map(n => <option key={n} value={n}>{n}×</option>)}</select>
			{button("richOrderedList", "insertOrderedList", "1. ≡")}{button("richIndent", "indent", "→")}{button("richOutdent", "outdent", "←")}
			{(['yy','fgx','bg','dmk'] as const).map((id,i) => <button key={id} type="button" disabled={disabled} onMouseDown={e => { e.preventDefault(); prepare(); }} onClick={() => insert(id)}>{t((['richQuote','richDivider','richTable','richCodeBlock'] as const)[i])}</button>)}
			{button("richPlainBlock", "plainBlock")}
		</div>}
	</div>;
}
