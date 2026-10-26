import { useEffect, useState } from "react";
import { FiCheck, FiChevronRight, FiMinus, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import type { SubagentItemView, SubagentPresentation } from "../subagent-presentation";
import { UiIcon } from "./UiIcon";

function duration(ms: number): string {
	if (ms < 100) return "<0.1s";
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

function Activity({ item, final }: { item: SubagentItemView; final: boolean }) {
	const t = useT();
	if (final && item.phase === "completed") return <span className="subagent-activity checked">{t("done")}</span>;
	if (item.phase === "queued") return <span className="subagent-activity">{t("toolQueued")}</span>;
	if (item.phase === "failed") return <span className="subagent-activity failed">{t("error")}</span>;
	if (item.phase === "cancelled") return <span className="subagent-activity failed">{t("subagentCancelled")}</span>;
	if (item.phase === "completed") return <span className="subagent-activity checked">{t("done")}</span>;
	const key = item.tool ? ({
		source_list: "subagentActivityList",
		source_search: "subagentActivitySearch",
		source_read: "subagentActivityRead",
		source_report: "subagentActivityReport",
	} as const)[item.tool] : "subagentSynthesizing";
	return <span className="subagent-activity running"><span className="thinking-spinner" aria-hidden="true" />{t(key)}</span>;
}

function StateIcon({ item }: { item: SubagentItemView }) {
	if (item.phase === "running") return <span className="subagent-state running"><span className="thinking-spinner" aria-hidden="true" /></span>;
	if (item.phase === "completed") return <span className="subagent-state checked"><FiCheck aria-hidden="true" /></span>;
	if (item.phase === "failed") return <span className="subagent-state failed"><FiX aria-hidden="true" /></span>;
	if (item.phase === "cancelled") return <span className="subagent-state failed"><FiMinus aria-hidden="true" /></span>;
	return <span className="subagent-state" aria-hidden="true">·</span>;
}

function SourceItem({ item, index, final }: { item: SubagentItemView; index: number; final: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(final && (index === 0 || item.phase === "failed" || item.phase === "cancelled"));
	useEffect(() => {
		if (final && (index === 0 || item.phase === "failed" || item.phase === "cancelled")) setOpen(true);
	}, [final, index, item.phase]);
	const knowledge = item.sourceId.startsWith("knowledge:");
	const summary = item.report?.summary || item.text;
	const omissions = [
		item.omittedFindings ? t("subagentOmittedFindings", { n: item.omittedFindings }) : "",
		item.omittedConnections ? t("subagentOmittedConnections", { n: item.omittedConnections }) : "",
		item.omittedOpenQuestions ? t("subagentOmittedOpenQuestions", { n: item.omittedOpenQuestions }) : "",
	].filter(Boolean);
	return <li className={`subagent-source ${item.phase}`} data-source-id={item.sourceId}>
		<button type="button" className="subagent-source-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
			<FiChevronRight className={`subagent-chevron${open ? " open" : ""}`} aria-hidden="true" />
			<StateIcon item={item} />
			<span className="subagent-source-identity"><strong title={item.root || item.source}>{item.source}</strong><span>{t(knowledge ? "subagentKnowledge" : "subagentRepository")}</span></span>
			<Activity item={item} final={final} />
		</button>
		<p className="subagent-source-task">{item.task}</p>
		{open && <div className="subagent-source-detail">
			{summary && <section className="subagent-report-section"><h4>{t("subagentSummary")}</h4><p className="subagent-summary">{summary}</p></section>}
			{item.report?.findings.length ? <section className="subagent-report-section"><h4>{t("subagentFindings", { n: item.report.findings.length })}</h4><div className="subagent-findings">{item.report.findings.map((finding, findingIndex) => <article className="subagent-finding" key={findingIndex}>
				<p><span className={`subagent-finding-kind ${finding.kind}`}>{t(({ implementation: "subagentFindingImplementation", documentation: "subagentFindingDocumentation", inference: "subagentFindingInference" } as const)[finding.kind])}</span>{finding.statement}</p>
				{finding.citations.map((citation, citationIndex) => <details className="subagent-citation" key={`${citation.path}:${citation.startLine}:${citation.endLine}:${citationIndex}`}><summary><code>{citation.path}:{citation.startLine}{citation.endLine !== citation.startLine ? `–${citation.endLine}` : ""}</code></summary><pre>{citation.excerpt}</pre></details>)}
			</article>)}</div></section> : final && !item.report?.findings.length && item.phase === "completed" ? <p className="subagent-empty-report">{t("subagentNoFindings")}</p> : null}
			{item.report && item.text && item.text !== item.report.summary && <details className="subagent-full-response"><summary>{t("subagentFullResponse")}</summary><p>{item.text}</p></details>}
			{!!item.report?.connections.length && <section className="subagent-report-section"><h4>{t("subagentConnections")}</h4><ul>{item.report.connections.map((connection, connectionIndex) => <li key={connectionIndex}>{connection}</li>)}</ul></section>}
			{!!item.report?.openQuestions.length && <section className="subagent-report-section"><h4>{t("subagentOpenQuestions")}</h4><ul>{item.report.openQuestions.map((question, questionIndex) => <li key={questionIndex}>{question}</li>)}</ul></section>}
			{item.evidenceWarning && <p className="subagent-warning"><UiIcon name="warning" />{item.evidenceWarning}</p>}
			{(item.truncated || item.outputTruncated || omissions.length > 0) && <p className="subagent-warning"><UiIcon name="warning" />{[t("subagentTruncated"), ...omissions].join(" · ")}</p>}
			{final && <div className="subagent-evidence-line">
				<span className={`subagent-evidence-badge ${item.evidenceStatus}`}>{t(item.evidenceStatus === "checked" ? "subagentEvidenceChecked" : "subagentEvidenceUnverified")}</span>
				{item.report?.checkedAt && <span>{t("subagentCheckedAt", { time: new Date(item.report.checkedAt).toLocaleString() })}</span>}
			</div>}
			{final && item.evidenceStatus === "checked" && <p className="subagent-evidence-note">{t("subagentEvidenceCheckedHint")}</p>}
			{item.root && <div className="subagent-source-root" title={item.root}><span>{t("subagentSourceRoot")}</span><code>{item.root}</code></div>}
			{final && <footer className="subagent-usage">
				{item.durationMs !== undefined && <span>{duration(item.durationMs)}</span>}
				{item.usage && <span title={t("subagentCacheUsage", { read: item.usage.cacheRead, write: item.usage.cacheWrite })}>{t("subagentTokenUsage", { input: item.usage.input, output: item.usage.output })}</span>}
				{item.usage && <span>${item.usage.cost.toFixed(4)}</span>}
			</footer>}
		</div>}
	</li>;
}

export function SubagentToolOutput({ model, argumentsText, outputText }: { model: SubagentPresentation; argumentsText: string; outputText: string }) {
	const t = useT();
	return <div className="subagent-view" data-final={model.final}>
		{model.workspace && <div className="subagent-workspace">Workspace · {model.workspace.name}</div>}
		<ol className="subagent-source-list">{model.items.map((item, index) => <SourceItem key={`${item.sourceId}:${index}`} item={item} index={index} final={model.final} />)}</ol>
		<details className="subagent-raw"><summary>{t("subagentRawData")}</summary><div><h4>{t("toolParameters")}</h4><pre>{argumentsText}</pre><h4>{t("output")}</h4><pre>{outputText}</pre></div></details>
	</div>;
}
