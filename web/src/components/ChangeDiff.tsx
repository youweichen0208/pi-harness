import type { CSSProperties } from "react";
import { foldDiff, type ChangedFile } from "../changes";
import { highlightLine, langFromPath } from "../hljs-lite";
import { useT } from "../i18n";

/** Shared diff renderer for inline edits and the changes workspace. */
export function ChangeDiff({ file, gaps, expandGap, query = "" }: { file: ChangedFile; gaps: Set<string>; expandGap: (id: string) => void; query?: string }) {
	const t = useT();
	const digits = file.lines.reduce((max, line) => Math.max(max, String(line.oldLine ?? "").length, String(line.newLine ?? "").length), 2);
	const renderLine = (index: number) => {
		const line = file.lines[index];
		const kind = line.marker === "+" ? "add" : line.marker === "-" ? "del" : "context";
		return <div key={index} className={`changes-line ${kind}${query && line.text.toLowerCase().includes(query.toLowerCase()) ? " search-match" : ""}`} data-change-hunk={line.marker !== " " && (index === 0 || file.lines[index - 1].marker === " ") ? "" : undefined}><span className="changes-line-number">{line.newLine ?? line.oldLine}</span><code className={/^#{1,6} /.test(line.text) ? "markdown-heading" : ""} dangerouslySetInnerHTML={{ __html: highlightLine(line.text, langFromPath(file.path)) }} /></div>;
	};
	const rows: React.ReactNode[] = [];
	const visible = foldDiff(file.lines);
	for (const row of visible) {
		if (row.kind === "line") rows.push(renderLine(row.index));
		else if (gaps.has(`${file.path}:${row.start}`) || query) {
			for (let n = row.start; n < row.end; n++) rows.push(renderLine(n));
		} else rows.push(<button key={`gap:${row.start}`} className="changes-gap" onClick={() => expandGap(`${file.path}:${row.start}`)}>{t(row.end === file.lines.length ? "changesTrailing" : "changesUnchanged", { n: row.end - row.start })}</button>);
	}
	return file.binary ? <p className="changes-empty">{t("changesBinary")}</p> : <div className="changes-file-lines diff-unified" style={{ "--diff-number-width": `${digits + 1}ch` } as CSSProperties}>
		{!file.lines.length && <p className="changes-meta">{t("changesUnavailable")}</p>}
		{file.unlocated && <p className="changes-meta">{t("changesUnlocated")}</p>}
		{rows}
		{file.truncated && <p className="changes-meta">{t("changesTruncated")}</p>}
	</div>;
}
