import { useMemo } from "react";
import { changedWords, foldDiff, type ChangedFile } from "../changes";
import { useT } from "../i18n";

/** Shared diff renderer for inline edits and the changes workspace. */
export function ChangeDiff({ file, gaps, expandGap, query = "" }: { file: ChangedFile; gaps: Set<string>; expandGap: (id: string) => void; query?: string }) {
	const t = useT();
	const peers = useMemo(() => {
		const pairs = new Map<number, string>();
		for (let index = 0; index < file.lines.length;) {
			if (file.lines[index].marker !== "-") { index++; continue; }
			const start = index; while (file.lines[index]?.marker === "-") index++;
			const added = index; while (file.lines[index]?.marker === "+") index++;
			for (let n = 0; n < Math.min(added - start, index - added); n++) { pairs.set(start + n, file.lines[added + n].text); pairs.set(added + n, file.lines[start + n].text); }
		}
		return pairs;
	}, [file.lines]);
	const renderLine = (index: number) => {
		const line = file.lines[index];
		const kind = line.marker === "+" ? "add" : line.marker === "-" ? "del" : "context";
		const peer = peers.get(index);
		const parts = peer === undefined ? [{ text: line.text, changed: false }] : changedWords(line.text, peer);
		return <div key={index} className={`changes-line ${kind}${query && line.text.toLowerCase().includes(query.toLowerCase()) ? " search-match" : ""}`} data-change-hunk={line.marker !== " " && (index === 0 || file.lines[index - 1].marker === " ") ? "" : undefined}><span className="changes-line-number">{line.newLine ?? line.oldLine}</span><span className="changes-line-sign">{line.marker}</span><code className={/^#{1,6} /.test(line.text) ? "markdown-heading" : ""}>{parts.map((part, n) => part.changed ? <mark key={n}>{part.text}</mark> : part.text)}</code></div>;
	};
	return file.binary ? <p className="changes-empty">{t("changesBinary")}</p> : <div className="changes-file-lines">
			{!file.lines.length && <p className="changes-meta">{t("changesUnavailable")}</p>}
			{file.unlocated && <p className="changes-meta">{t("changesUnlocated")}</p>}
			{foldDiff(file.lines).map(row => row.kind === "line" ? renderLine(row.index) : gaps.has(`${file.path}:${row.start}`) || query ? Array.from({ length: row.end - row.start }, (_, n) => renderLine(row.start + n)) : <button key={`gap:${row.start}`} className="changes-gap" onClick={() => expandGap(`${file.path}:${row.start}`)}>{t(row.end === file.lines.length ? "changesTrailing" : "changesUnchanged", { n: row.end - row.start })}</button>)}
			{file.truncated && <p className="changes-meta">{t("changesTruncated")}</p>}
		</div>;
}
