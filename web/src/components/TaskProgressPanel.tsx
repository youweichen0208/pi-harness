import { UiIcon } from "./UiIcon";
import { toolTextIncidents } from "../tool-text";
import { conversationWait } from "../waiting-indicator";
import { useEffect, useMemo, useRef, useState } from "react";
import { FiChevronRight, FiFile } from "react-icons/fi";
import type { ServerMessage, TaskProgress, UiMessage } from "../types";
import { useI18n, useT } from "../i18n";
import { phaseHeadline, phaseItems, planStepArtifacts, progressPhases } from "../task-progress-view";
import { commandDuration, elapsedLabel } from "../bash-presentation";
import { taskOutputs } from "../task-outputs";

type Silence = Extract<ServerMessage, { type: "agent_silence" }> | null;

export function TaskProgressPanel({ task, silence, cwd, messages, onPreview, streaming, live }: { task?: TaskProgress | null; silence: Silence; cwd: string; messages: UiMessage[]; onPreview: (path: string, name: string) => void; streaming?: boolean; live?: UiMessage | null }) {
	const t = useT();
	const { locale } = useI18n();
	const incident = toolTextIncidents(live ? [...messages, live] : messages, streaming ?? task?.status === "running").current;
	const interrupted = incident?.state === "stopped";
	const reminding = incident?.state === "reminding";
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		if (!reminding) return;
		const start = incident?.reminders.at(-1)?.timestamp ?? Date.now();
		const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
		update(); const timer = window.setInterval(update, 1000);
		return () => window.clearInterval(timer);
	}, [reminding, incident?.incidentId]);
	const phase = conversationWait(messages, new Map());
	const [progressOpen, setProgressOpen] = useState(true);
	const [outputsOpen, setOutputsOpen] = useState(true);
	const [expanded, setExpanded] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const items = task?.plan?.items.filter(item => item.status !== "removed") ?? [];
	const currentId = items.find(item => item.status === "running")?.id;
	useEffect(() => {
		if (!progressOpen || !currentId) return;
		const scroller = scrollRef.current;
		const active = scroller?.querySelector<HTMLElement>(".task-plan-step.running");
		if (!scroller || !active) return;
		const top = active.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
		scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
	}, [currentId, task?.id, progressOpen]);
	const preview = (path: string) => {
		const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
		onPreview(relative, relative.replace(/\\/g, "/").split("/").at(-1) ?? relative);
	};
	const files = taskOutputs(task, messages, cwd);
	// 无 plan 的任务也给出可读的阶段进度（issue #63）：相邻工具步骤归并为阶段，
	// 复用 plan 清单的行样式；有 plan 时清单已经是更权威的进度，不再叠加。
	const phases = useMemo(() => task && !task.plan ? progressPhases(task) : [], [task]);
	// Without a native plan the rows are grouped tool steps, not a plan the model wrote.
	const stepLog = phases.length > 0 && !interrupted && !reminding;
	const planMessage = messages.find(message => message.role === "toolResult" && message.planSnapshot?.planId === task?.plan?.origin);
	const planSource = planMessage && messages.find(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === planMessage.toolCallId));
	const status = interrupted ? t("toolRecoveryInterrupted") : reminding ? `${t("working")} · ${t("waitSeconds", { n: elapsed })}` : task?.status === "failed" ? t("taskFailed") : task?.status === "cancelled" ? t("taskCancelled") : task?.plan?.awaitingConfirmation ? t("planPrevious") : task?.status === "waiting" ? t("taskPlanOpen") : silence && task && silence.conversationId === task.conversationId ? t(phase?.label ?? "working") : "";
	if (!task && !streaming && !interrupted && !reminding && !files.length) return null;
	return <div className={`task-progress task-sections ${interrupted ? "interrupted" : reminding ? "reminding" : task?.status ?? "empty"}`} tabIndex={-1} aria-label={t("taskProgress")}>
		<div className="task-sections-scroll" ref={scrollRef}>
			<section className="task-section">
				<button type="button" className="task-section-heading" aria-expanded={progressOpen} onClick={() => setProgressOpen(value => !value)}><FiChevronRight className={progressOpen ? "open" : ""} />{t(stepLog ? "taskStepsHeading" : "taskProgressHeading")}{stepLog && <span className="task-section-count">{t("taskStepsCount", { n: phases.length })}</span>}</button>
				{progressOpen && <div className="task-section-content">
					{status && (!interrupted || !!task?.plan) && <p className={`task-progress-status task-progress-source ${interrupted ? "interrupted" : reminding ? "reminding" : task?.status}`} role="status">{reminding && <i aria-hidden="true" />}{status}</p>}
					{task?.plan && items.length ? <>
						{task.plan.completionCriteria && <p className="task-outline-criteria">{t("taskCompletionCriteria")}：{task.plan.completionCriteria}</p>}
						<div className="task-plan-list">{items.map(item => <div key={item.id} className={`task-plan-step ${interrupted && item.status === "running" ? "interrupted" : item.status}${expanded === item.id ? " expanded" : ""}`}>
							<button type="button" className="task-plan-step-head" aria-expanded={expanded === item.id} onClick={() => setExpanded(value => value === item.id ? null : item.id)}>
								<span className="task-plan-mark" aria-hidden="true">{interrupted && item.status === "running" ? "×" : item.status === "done" ? "✓" : item.status === "running" ? "●" : ""}</span>
								<span className="task-plan-step-title">{item.title}</span><FiChevronRight className={expanded === item.id ? "open" : ""} />
							</button>
							{expanded === item.id && <div className="task-plan-step-detail">
								{item.detail && <p>{item.detail}</p>}
								{!!item.blockedBy?.length && <p>{t("taskBlockedBy", { steps: item.blockedBy.join(", ") })}</p>}
								{planStepArtifacts(task, item).map(({ artifact, messageId }) => <div className="task-artifact-row" key={artifact.toolCallId}>
									{artifact.path && <button type="button" title={artifact.path} onClick={() => preview(artifact.path!)}>{artifact.path}</button>}
									<button type="button" title={t("taskJumpToChat")} onClick={() => window.dispatchEvent(new CustomEvent("pi:jump-tool", { detail: { messageId, toolCallId: artifact.toolCallId } }))}>{artifact.path ? <UiIcon name="external" /> : artifact.label}</button>
								</div>)}
								<button type="button" className="task-step-jump" onClick={() => window.dispatchEvent(new CustomEvent("pi:jump-message", { detail: { messageId: planSource?.id ?? task.sourceMessageId } }))}>{t("taskJumpToChat")} →</button>
							</div>}
						</div>)}</div>
					</> : stepLog ? <ol className="task-step-log">{phases.map(phase => {
						const items = phaseItems(phase, cwd);
						const shown = items.slice(0, 4);
						const duration = phase.status !== "running" && phase.endedAt && phase.startedAt ? phase.endedAt - phase.startedAt : undefined;
						return <li key={phase.id} className={`task-step ${phase.status}`}>
							<span className="task-step-mark" aria-hidden="true">{phase.status === "done" ? "✓" : phase.status === "failed" ? "×" : <i className="thinking-spinner" />}</span>
							<span className="task-step-title">{phaseHeadline(phase, locale)}</span>
							{duration !== undefined && duration >= 100 && <span className="task-step-time">{duration < 60_000 ? commandDuration(duration) : elapsedLabel(duration / 1000)}</span>}
							{shown.length > 0 && <ul className="task-step-items">
								{shown.map(item => <li key={item.key}><button type="button" title={item.path ?? item.label} onClick={() => item.path ? preview(item.path) : window.dispatchEvent(new CustomEvent("pi:jump-tool", { detail: { messageId: item.messageId, toolCallId: item.toolCallId } }))}>{item.label}</button></li>)}
								{items.length > shown.length && <li className="task-step-more">{t("taskStepsMore", { n: items.length - shown.length })}</li>}
							</ul>}
						</li>;
					})}</ol> : interrupted ? <div className="task-interrupted-hint"><strong>● {t("taskInterruptedTitle")}</strong><p>{t("taskInterruptedHint")}</p></div> : reminding ? null : <div className="task-section-empty"><div className="task-empty-circles" aria-hidden="true"><i /><i /><i /></div><p>{t("taskProgressEmpty")}</p></div>}
				</div>}
			</section>
			<section className="task-section">
				<button type="button" className="task-section-heading" aria-expanded={outputsOpen} onClick={() => setOutputsOpen(value => !value)}><FiChevronRight className={outputsOpen ? "open" : ""} />{t("taskOutputsHeading")}</button>
				{outputsOpen && <div className="task-section-content">{files.length ? <div className="task-file-results">{files.map(file => <div className="task-file-result" key={file.path}>
					<FiFile aria-hidden="true" /><button type="button" title={file.path} onClick={() => preview(file.path)}><span>{file.path.split("/").at(-1)}</span>{file.path.includes("/") && <small>{file.path}</small>}</button>
					{file.counted && <span className="task-file-counts"><span>+{file.added}</span> <span>−{file.removed}</span></span>}
				</div>)}</div> : <div className="task-section-empty"><FiFile className="task-empty-file" aria-hidden="true" /><p>{t("taskOutputsEmpty")}</p></div>}</div>}
			</section>
		</div>
	</div>;
}
