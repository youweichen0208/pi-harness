import { useState } from "react";
import { FiFile, FiChevronRight } from "react-icons/fi";
import type { ChangedFile } from "../changes";
import { useChanges } from "../changes-context";
import { useT } from "../i18n";

export function ChangeCounts({ files }: { files: Pick<ChangedFile, "added" | "removed" | "counted">[] }) {
	if (!files.some(file => file.counted)) return null;
	const added = files.reduce((n, file) => n + file.added, 0), removed = files.reduce((n, file) => n + file.removed, 0);
	return <span className="change-counts"><span className="add">+{added}</span><span className="del">−{removed}</span></span>;
}
export function ChangeSummaryCard({ files }: { files: ChangedFile[] }) {
	const t = useT(), changes = useChanges();
	const [all, setAll] = useState(false);
	if (!files.length || !changes) return null;
	return <section className="change-summary">
		<header><strong>{t("changesSummary", { n: files.length })}</strong><ChangeCounts files={files} /><button onClick={() => changes.show(files)}>{t("changesViewAll")}</button></header>
		{(all ? files : files.slice(0, 6)).map(file => <button key={file.path} className={`change-summary-file ${changes.open && changes.selected === file.path ? "selected" : ""}`} onClick={() => changes.show(files, file.path)}>
			<FiFile /><span className="change-summary-name" title={file.path}><code>{file.path.split("/").at(-1)}</code><span className="change-directory">{file.path.split("/").slice(0, -1).join("/")}</span></span>
			{file.counted && file.added + file.removed > 0 && <span className="change-ratio" aria-hidden="true">{file.added > 0 && <i className="add" style={{ flexGrow: file.added }} />}{file.removed > 0 && <i className="del" style={{ flexGrow: file.removed }} />}</span>}
			{file.counted ? <ChangeCounts files={[file]} /> : <span className="change-summary-unavailable" title={t("changesUnavailable")}>—</span>}<FiChevronRight />
		</button>)}
		{!all && files.length > 6 && <button className="changes-more" onClick={() => setAll(true)}>{t("changesMore", { n: files.length - 6 })}</button>}
	</section>;
}
