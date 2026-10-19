import { useDialogFocus } from "../use-dialog-focus";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";
import type { WikiIndexStatus } from "../types";
import { wikiIndexIssueGroups } from "../wiki-index-summary";
import { useI18n, useT } from "../i18n";

export function WikiReadingDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
	const t = useT(), dialog = useDialogFocus<HTMLElement>();
	return createPortal(<div className="wiki-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
		<section ref={dialog} className="wiki-reading-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={e => {
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
		}}>
			<header><h2>{title}</h2><button aria-label={t("close")} onClick={onClose}><FiX /></button></header>
			{children}
		</section>
	</div>, document.querySelector(".wiki-document-dialog") ?? document.body);
}

export function WikiIndexIndicator({ status }: { status: WikiIndexStatus }) {
	const t = useT(), { locale } = useI18n(), [open, setOpen] = useState(false);
	const reasons = { "file-size": "wikiIndexFileSize", "byte-budget": "wikiIndexBudget", "entry-limit": "wikiIndexEntries", "depth-limit": "wikiIndexDepth", unreadable: "wikiIndexUnreadable" } as const;
	const count = (n: number) => n.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
	const issueCount = status.issues.length;
	const groups = wikiIndexIssueGroups(status.issues);
	const summary = t("wikiIndexStatus", { indexed: count(status.indexed), total: status.totalIsLowerBound ? t("wikiIndexCounting") : count(status.total) });
	if (!open && !issueCount && !status.totalIsLowerBound && status.indexed === status.total) return null;
	return <>
		<button className={`wiki-index-status ${issueCount ? "limited" : ""}`} onClick={() => setOpen(true)} title={[summary, ...groups.map(group => t("wikiIndexIssueCount", { count: count(group.count), reason: t(reasons[group.reason]) }))].join("\n")}>
			{issueCount > 0 && <i />}<span>{summary}</span>
			{issueCount > 0 && <span className="wiki-index-reason"> · {t("wikiIndexSkipped", { count: count(issueCount) })}</span>}
		</button>
		{open && <WikiReadingDialog title={summary} onClose={() => setOpen(false)}>
			<p>{t(status.totalIsLowerBound ? "wikiIndexPartial" : issueCount ? "wikiIndexHint" : "wikiIndexComplete")}</p>
			<ul className="wiki-index-summary">{groups.map(group => <li key={group.reason}>{t("wikiIndexIssueCount", { count: count(group.count), reason: t(reasons[group.reason]) })}</li>)}</ul>
			<div className="wiki-index-issues">{status.issues.map((issue, i) => <div key={`${issue.path}:${i}`}>
				<code>{issue.path}</code><span>{issue.size === undefined ? "—" : `${(issue.size / 1024 / 1024).toFixed(2)} MB`}</span>
				<small>{t(reasons[issue.reason])}{issue.subtree ? ` · ${t("wikiIndexSubtree")}` : ""}</small>
			</div>)}</div>
		</WikiReadingDialog>}
	</>;
}
