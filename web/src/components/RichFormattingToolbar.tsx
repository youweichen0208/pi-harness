import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { RichCommands, RichCommand } from "../rich-commands";
export function RichFormattingToolbar({ compact, commands }: { compact: boolean; commands: RichCommands }) {
	const t = useT(); const [more, setMore] = useState(!compact && window.innerWidth > 700);
	const disabled = !commands.enabled;
	useEffect(() => {
		const narrow = matchMedia("(max-width: 700px)");
		const changed = () => { if (narrow.matches) setMore(false); };
		narrow.addEventListener("change", changed); return () => narrow.removeEventListener("change", changed);
	}, []);
	const button = (id: RichCommand, text?: string) => {
		const label = t(commands.describe(id).label);
		return <button type="button" disabled={disabled} title={label} aria-label={label} onMouseDown={e => { e.preventDefault(); commands.prepare(); }} onClick={() => commands.execute(id)}>{text ?? label}</button>;
	};
	const select = (id: RichCommand, initial = "") => {
		const definition = commands.describe(id), label = t(definition.label);
		return <select aria-label={label} defaultValue={initial} disabled={disabled} onFocus={commands.prepare} onChange={e => { commands.execute(id, e.target.value); if (!initial) e.target.value = ""; }}>
			{!initial && <option value="" disabled>{label}</option>}
			{definition.options?.map(option => <option key={option.value} value={option.value}>{option.label ? t(option.label) + (option.suffix ?? "") : option.text ?? option.value}</option>)}
		</select>;
	};
	return <div className="rich-format-tools" role="toolbar" aria-label={t("richFormatToolbar")}>
		{button("undo", "↶")}{button("redo", "↷")}{select("formatBlock")}
		{button("bold", "B")}{button("italic", "I")}{button("insertUnorderedList", "• ≡")}{button("task", "☑")}
		<select aria-label={t("richBlocksGroup")} disabled={disabled} defaultValue="" onFocus={commands.prepare} onChange={e => { commands.insert(e.target.value); e.target.value = ""; }}><option value="" disabled>＋ {t("richInsertMenu")}</option>{([['tip','richGreenBlock'],['glk','richBlueBlock'],['warning','richYellowBlock'],['collapse','richCollapse'],['tp','richImage'],['link','wikiAddLink'],['card','richLinkCard']] as const).map(([id,label]) => <option key={id} value={id}>{t(label)}</option>)}</select>
		<button type="button" aria-expanded={more} onClick={() => setMore(!more)}>{t("richMore")}</button>
		{more && <div className="rich-format-more">
			{select("font-size", "15px")}
			{button("underline", "U")}{button("strikeThrough", "S̶")}{button("superscript", "x²")}{button("subscript", "x₂")}
			{select("color")}{select("highlight")}{select("text-align")}{select("line-height", "1.74")}
			{button("insertOrderedList", "1. ≡")}{button("indent", "→")}{button("outdent", "←")}
			{(['yy','fgx','bg','dmk'] as const).map((id,i) => <button key={id} type="button" disabled={disabled} onMouseDown={e => { e.preventDefault(); commands.prepare(); }} onClick={() => commands.insert(id)}>{t((['richQuote','richDivider','richTable','richCodeBlock'] as const)[i])}</button>)}
			{button("plainBlock")}
		</div>}
	</div>;
}
