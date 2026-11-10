import { isToolTextContinuation } from "../../../server/tool-text";
import { currentCodemodeGroups, type CodemodeActivity } from "../codemode-records";
import { CodemodeRecords } from "./CodemodeRecords";
import { UiIcon } from "./UiIcon";
import { toolTextIncidents } from "../tool-text";
import { useEffect, useMemo, useRef, useState } from "react";
import { FiChevronRight } from "react-icons/fi";
import type { ClientMessage, ServerMessage, TaskProgress, UiMessage } from "../types";
import { useI18n, useT } from "../i18n";
import { phaseHeadline, phaseItems, phaseRecords, planStepArtifacts, progressPhases } from "../task-progress-view";
import { commandDuration, elapsedLabel } from "../bash-presentation";

type Silence = Extract<ServerMessage, { type: "agent_silence" }> | null;

type TaskProgressPanelProps = CodemodeActivity & { send?: (message: ClientMessage) => boolean; conversationId?: string; task?: TaskProgress | null; silence: Silence; cwd: string; messages: UiMessage[]; onPreview: (path: string, name: string) => void; streaming?: boolean; live?: UiMessage | null };

export function TaskProgressPanel(props: TaskProgressPanelProps) {
	const history = props.codemode?.history ?? props.messages;
	const request = history.findLast((message, index) => message.role === "user" && message.origin !== "auto-reminder" && !isToolTextContinuation(history, index));
	return <TaskProgressContent key={`${props.conversationId ?? ""}:${props.task?.sourceMessageId ?? request?.id ?? "empty"}`} {...props} />;
}

function TaskProgressContent({ send, codemode, liveOutputs, toolStatuses, conversationId, task, cwd, messages, onPreview, streaming, live }: TaskProgressPanelProps) {
	const t = useT();
	const codemodeGroups = useMemo(() => currentCodemodeGroups(messages, live, streaming ?? task?.status === "running", { codemode, liveOutputs, toolStatuses }, conversationId), [messages, live, streaming, task?.status, codemode, liveOutputs, toolStatuses, conversationId]);
	const { locale } = useI18n();
	const incident = toolTextIncidents(live ? [...messages, live] : messages, streaming ?? task?.status === "running").current;
	const interrupted = incident?.state === "stopped";
	const reminding = incident?.state === "reminding";
	const [progressOpen, setProgressOpen] = useState(true);
	const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	/** Once the reader scrolls the panel themselves, stop following the running step:
	 *  a streaming turn changes `currentId` repeatedly and the follow used to yank the
	 *  panel back mid-read (e.g. while browsing 本轮文件 or an opened file preview). */
	const userScrolled = useRef(false);
	const items = task?.plan?.items.filter(item => item.status !== "removed") ?? [];
	const currentId = items.find(item => item.status === "running")?.id;
	useEffect(() => {
		if (!progressOpen || !currentId) return;
		// 只要读者自己碰过这个面板就不再跟随，否则流式期间 currentId 每次变化
		// 都会把人正在看的位置拽回去。本轮换轮时组件按 sourceMessageId 重挂载，守卫自然归零。
		if (userScrolled.current) return;
		const scroller = scrollRef.current;
		const active = scroller?.querySelector<HTMLElement>(".task-plan-step.running");
		if (!scroller || !active) return;
		// 步骤行已经在可视区内就不要动它，避免无谓的滚动跳变。
		const box = scroller.getBoundingClientRect();
		const row = active.getBoundingClientRect();
		if (row.top >= box.top && row.bottom <= box.bottom) return;
		scroller.scrollTop = Math.max(0, row.top - box.top + scroller.scrollTop - scroller.clientHeight / 3);
	}, [currentId, task?.id, progressOpen]);
	const preview = (path: string) => {
		// 打开预览会改变右栏布局，不要顺手把面板滚回当前步骤。
		userScrolled.current = true;
		const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
		onPreview(relative, relative.replace(/\\/g, "/").split("/").at(-1) ?? relative);
	};
	// 无 plan 的任务也给出可读的阶段进度（issue #63）：相邻工具步骤归并为阶段，
	// 复用 plan 清单的行样式；有 plan 时清单已经是更权威的进度，不再叠加。
	const phases = useMemo(() => task && !task.plan ? progressPhases(task) : [], [task]);
	// Without a native plan the rows are grouped tool steps, not a plan the model wrote.
	const stepLog = phases.length > 0 && !interrupted && !reminding;
	const planMessage = messages.find(message => message.role === "toolResult" && message.planSnapshot?.planId === task?.plan?.origin);
	const planSource = planMessage && messages.find(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === planMessage.toolCallId));
	const empty = !task && !streaming && !interrupted && !reminding && !codemodeGroups.length;
	const state = interrupted ? "interrupted" : reminding ? "reminding" : task?.status ?? (streaming ? "running" : undefined);
	return <div className={`task-progress task-sections ${state ?? "empty"}`} tabIndex={-1} aria-label={t("taskProgress")}>
		<div className="task-sections-scroll" ref={scrollRef} onPointerDown={() => { userScrolled.current = true; }} onWheel={() => { userScrolled.current = true; }} onTouchMove={() => { userScrolled.current = true; }} onKeyDown={event => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) userScrolled.current = true; }}>
			{empty ? <p className="task-panel-empty">{t("taskPanelEmpty")}</p> : <>
			<section className="task-section">
				<button type="button" className="task-section-heading" aria-expanded={progressOpen} onClick={() => setProgressOpen(value => !value)}><FiChevronRight className={progressOpen ? "open" : ""} />{t(stepLog ? "taskStepsHeading" : "taskProgressHeading")}{stepLog && <span className="task-section-count">{t("taskStepsCount", { n: phases.length })}</span>}</button>
				{progressOpen && <div className="task-section-content">
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
						const items = phaseRecords(phase.steps, cwd);
						const duration = phase.status !== "running" && phase.endedAt && phase.startedAt ? phase.endedAt - phase.startedAt : undefined;
						return <li key={phase.id} className={`task-step ${phase.status}`}>
							<span className="task-step-mark" aria-hidden="true">{phase.status === "done" ? "✓" : phase.status === "failed" ? "×" : <svg className="task-step-spinner" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="29 9" /></svg>}</span>
							<button type="button" className="task-step-title task-step-toggle" title={phaseHeadline(phase, locale)} aria-expanded={expandedPhase === phase.id} onClick={() => setExpandedPhase(value => value === phase.id ? null : phase.id)}><span>{phaseHeadline(phase, locale, true)}</span><FiChevronRight className={expandedPhase === phase.id ? "open" : ""} /></button>
							{phase.status === "running" && <span className="task-step-current">{t("taskStepCurrent")}</span>}
							{duration !== undefined && duration >= 100 && <span className="task-step-time">{duration < 60_000 ? commandDuration(duration) : elapsedLabel(duration / 1000)}</span>}
							{expandedPhase === phase.id && items.length > 0 && <ul className="task-step-items">
								{items.map(item => <li key={item.key} className={item.path ? undefined : "command"}><button type="button" title={item.path ?? item.label} onClick={() => item.path ? preview(item.path) : window.dispatchEvent(new CustomEvent("pi:jump-tool", { detail: { messageId: item.messageId, toolCallId: item.toolCallId } }))}>{item.label}</button></li>)}
							</ul>}
						</li>;
					})}</ol> : interrupted ? <div className="task-interrupted-hint"><strong>● {t("taskInterruptedTitle")}</strong><p>{t("taskInterruptedHint")}</p></div> : reminding ? null : <div className="task-section-empty"><p>{t(streaming ? "taskStepsPending" : "taskStepsEmpty")}</p></div>}
				</div>}
			</section>
			<CodemodeRecords groups={codemodeGroups} messages={live ? [...messages, live] : messages} conversationId={conversationId} send={send}/>
			</>}
		</div>
	</div>;
}
