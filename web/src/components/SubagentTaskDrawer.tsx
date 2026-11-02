import { WorkspacePathContext } from "../workspace-context";
import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { randomUuid } from "../uuid";
import type { SubagentResponse, UiSubagentTaskDetail } from "../types";
import { subagentPresentation, type SubagentItemView } from "../subagent-presentation";
import { subagentFailed, subagentRetryArguments } from "../subagent-errors";
import { SubagentStatus, subagentTerminal } from "./SubagentTurnPanel";
import { Markdown } from "./Markdown";

export function SubagentTaskDrawer({ item, argumentsText, outputText, onClose }: { item: SubagentItemView; argumentsText: string; outputText: string; onClose: () => void }) {
	const t = useT();
	const cwd = useContext(WorkspacePathContext);
	const [tab, setTab] = useState(subagentTerminal(item) ? "result" : "process");
	const [detail, setDetail] = useState<UiSubagentTaskDetail>();
	const [error, setError] = useState(false);
	const [retryReady, setRetryReady] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const scroll = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const terminalItem = useRef(subagentTerminal(item)); terminalItem.current = subagentTerminal(item);
	const request = useRef<(action?: "detail" | "stop") => void>(() => {});
	const close = useRef(onClose); close.current = onClose;
	useEffect(() => {
		const trigger = document.activeElement as HTMLElement | null;
		box.current?.focus();
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
			if (event.key !== "Tab") return;
			const nodes = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])].filter(node => node.getClientRects().length);
			if (!nodes.length) return;
			const first = nodes[0], last = nodes[nodes.length - 1];
			if (event.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { event.preventDefault(); last.focus(); }
			else if (!event.shiftKey && (document.activeElement === last || document.activeElement === box.current)) { event.preventDefault(); first.focus(); }
		};
		document.addEventListener("keydown", key, true);
		return () => { document.removeEventListener("keydown", key, true); if (trigger?.isConnected) trigger.focus(); };
	}, []);
	useEffect(() => {
		if (!item.taskId) return;
		let cursor = 0, pending = "", sentAt = 0, finished = terminalItem.current, detailError = false;
		const send = (action: "detail" | "stop" = "detail", force = false) => {
			if (!force && pending && Date.now() - sentAt < 10000 && action !== "stop") return;
			pending = randomUuid(); sentAt = Date.now();
			window.dispatchEvent(new CustomEvent("pi:subagent-request", { detail: { requestId: pending, taskId: item.taskId, action, cursor } }));
		};
		request.current = (action = "detail") => send(action, true);
		const response = (event: Event) => {
			const message = (event as CustomEvent<SubagentResponse>).detail;
			if (message.taskId !== item.taskId || message.requestId !== pending) return;
			pending = "";
			if (!message.detail || message.error) { detailError = true; setError(true); if (terminalItem.current) finished = true; return; }
			detailError = false; setError(false);
			const next = message.detail;
			cursor = next.events.at(-1)?.seq !== undefined ? next.events.at(-1)!.seq + 1 : cursor;
			finished = subagentTerminal(next.task) && next.nextCursor === undefined;
			setDetail(old => ({ ...next, events: [...(old?.events ?? []), ...next.events] }));
			if (next.nextCursor !== undefined) send();
		};
		window.addEventListener("pi:subagent-response", response);
		send();
		const timer = setInterval(() => { if (!finished && (!terminalItem.current || !detailError)) send(); }, 1000);
		return () => { clearInterval(timer); window.removeEventListener("pi:subagent-response", response); request.current = () => {}; };
	}, [item.taskId]);
	useEffect(() => { if (follow.current && tab === "process") scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [detail?.events.length, tab]);
	const parsed = detail?.resultText ? subagentPresentation('{"action":"run"}', `{"results":[${detail.resultText}]}`)?.items[0] : undefined;
	const current = parsed ?? { ...item, ...detail?.task };
	const steps = current.steps ?? [];
	return createPortal(<div className="subagent-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
		<div className="subagent-drawer" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={current.title || current.task}>
			<header><div><small>{t("subagentTaskDetail")}</small><h2>{current.title || current.task || current.source}</h2></div><button type="button" aria-label={t("close")} onClick={onClose}><FiX /></button></header>
			<div className="subagent-drawer-meta"><SubagentStatus item={current} /><span>{current.sources?.map(source => source.name).join(" · ") || current.source}</span>{current.durationMs !== undefined && <span>{(current.durationMs / 1000).toFixed(1)}s</span>}{!subagentTerminal(current) && current.taskId && <button type="button" disabled={current.phase === "stopping"} onClick={() => request.current("stop")}>{t("subagentStopTask")}</button>}</div>
			<nav className="subagent-drawer-tabs" aria-label={t("subagentTaskDetail")}><button type="button" aria-pressed={tab === "process"} onClick={() => setTab("process")}>{t("subagentProcessTab")}</button><button type="button" aria-pressed={tab === "result"} onClick={() => setTab("result")}>{t("subagentResultTab")}</button></nav>
			<div className="subagent-drawer-content" ref={scroll} onScroll={() => { const el = scroll.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
				{error && <p role="status">{t("subagentDetailUnavailable")} <button type="button" onClick={() => request.current()}>{t("retry")}</button></p>}
				<details className="subagent-task-instruction"><summary>{t("subagentTaskLabel")}</summary><p>{current.task}</p></details>
				{tab === "process" ? <>
					{!steps.length && <p className="subagent-detail-note">{t(!subagentTerminal(current) ? "subagentAwaitingSteps" : current.taskId && subagentFailed(current) ? "subagentError_noSteps" : "subagentNoStepHistory")}</p>}
					<ol className="subagent-task-timeline">{steps.map(step => {
						const start = detail?.events.find(event => event.toolCallId === step.id && event.type === "tool_start");
						const end = detail?.events.find(event => event.toolCallId === step.id && event.type === "tool_end");
						return <li key={step.id} data-step-status={step.status}><div><strong>{t(({ source_list: "subagentStepList", source_read: "subagentStepRead", source_search: "subagentStepSearch", source_report: "subagentStepReport" } as const)[step.tool])}</strong><span>{t(step.status === "completed" ? "done" : step.status === "running" ? "running" : step.status === "cancelled" ? "subagentCancelled" : "error")}{step.durationMs !== undefined ? ` · ${(step.durationMs / 1000).toFixed(1)}s` : ""}</span></div><small>{current.sources?.find(source => source.id === step.sourceId)?.name}</small>{step.target && <code>{step.target}</code>}{start && <details><summary>{t("toolParameters")}</summary><pre>{start.text}</pre></details>}{end && <details><summary>{t("output")}{end.truncated ? ` · ${t("subagentTruncated")}` : ""}</summary><pre>{end.text}</pre></details>}</li>;
					})}</ol>
					{detail?.events.filter(event => event.type === "answer").map(event => <details key={event.seq}><summary>{t("subagentPublicAnswer")}</summary><Markdown text={event.text} /></details>)}
					{detail?.truncated && <p>{t("subagentRecordTruncated")}</p>}
				</> : <div className="subagent-task-result">
					{!subagentTerminal(current) && <p>{t("subagentAwaitingReport")}</p>}
					{current.text && current.text !== current.report?.summary && <Markdown text={current.text} />}
					{current.report && <><h3>{t("subagentConclusion")}</h3><Markdown text={current.report.summary} /><ol>{current.report.findings.map((finding, index) => <li key={index}><small>{t(({ implementation: "subagentFindingImplementation", documentation: "subagentFindingDocumentation", inference: "subagentFindingInference" } as const)[finding.kind])}</small><p>{finding.statement}</p>{finding.citations.map((citation, n) => <details key={n}><summary>{current.sources?.find(source => source.id === citation.sourceId)?.name} · {citation.path}:{citation.startLine}–{citation.endLine}</summary><pre>{citation.excerpt}</pre>{(current.sources?.find(source => source.id === citation.sourceId)?.root ?? current.root).replaceAll("\\", "/").replace(/\/$/, "") === cwd.replaceAll("\\", "/").replace(/\/$/, "") && <button type="button" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", { detail: { path: citation.path, line: citation.startLine } })); }}>{t("subagentOpenCitation")}</button>}</details>)}</li>)}</ol>{[...current.report.connections, ...current.report.openQuestions].map((text, index) => <p key={index}>{text}</p>)}</>}
					{current.evidenceWarning && <p className="subagent-detail-note">{current.evidenceWarning}</p>}
					{current.report && <p className="subagent-detail-note">{t("subagentEvidenceCheckedHint")}</p>}
					{current.usage && <p>{t("subagentTokenUsage", { input: current.usage.input, output: current.usage.output })}{current.usage.cost > 0 ? ` · $${current.usage.cost.toFixed(4)}` : ""}</p>}
					{subagentFailed(current) && <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent("pi-harness:prepare-subagent-retry", { detail: { text: `${t("subagentRetryPrompt")}\n${subagentRetryArguments([current], argumentsText)}` } })); setRetryReady(true); }}>{t("subagentPrepareRetry")}</button>}
					{retryReady && <p role="status">{t("subagentRetryReady")}</p>}
					<details><summary>{t("subagentRawData")}</summary><pre>{argumentsText}</pre><pre>{detail?.resultText || outputText}</pre></details>
				</div>}
			</div>
		</div>
	</div>, document.body);
}
