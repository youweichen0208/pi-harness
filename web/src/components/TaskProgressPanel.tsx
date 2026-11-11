import { isToolTextContinuation } from "../../../server/tool-text";
import { currentCodemodeGroups, type CodemodeActivity } from "../codemode-records";
import { CodemodeRecords } from "./CodemodeRecords";
import { UiIcon } from "./UiIcon";
import { toolTextIncidents } from "../tool-text";
import { useEffect, useMemo, useRef, useState } from "react";
import { FiChevronRight } from "react-icons/fi";
import type { ClientMessage, ServerMessage, TaskProgress, UiMessage } from "../types";
import { useI18n, useT } from "../i18n";
import { phaseHeadline, phaseRecords, progressPhases, stepKindTag } from "../task-progress-view";
import { commandDuration, elapsedLabel } from "../bash-presentation";

type Silence = Extract<ServerMessage, { type: "agent_silence" }> | null;

/** 命令列表超过这个数就只先露几条：一整屏都是命令时，步骤日志就失去扫读能力。 */
const STEP_ITEMS_PREVIEW = 8;

/** 右栏一列的耗时：1 毫秒级噪声太多，十分钟以上省掉秒，一小时后只要分钟。 */
function compactDuration(ms: number): string | null {
	if (ms < 100) return null;
	if (ms < 60_000) return commandDuration(ms);
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor(ms % 60_000 / 1000)}s`;
	return `${Math.floor(ms / 3_600_000)}h ${Math.floor(ms % 3_600_000 / 60_000)}m`;
}

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
	// 运行中默认展开概览；本轮结束后收成一行，把高度让给步骤列表。
	// 读者手动开合过的选择会盖过默认值（在一轮之内保留）。
	const [overviewChoice, setOverviewChoice] = useState<boolean | null>(null);
	const [progressOpen, setProgressOpen] = useState(true);
	const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
	// 运行中的步骤默认展开自己的条目（读者要看的正是此刻在跑什么），可折叠。
	const [compactActive, setCompactActive] = useState(false);
	const [expanded, setExpanded] = useState<string | null>(null);
	// 命令列表超过这个数就只先露几条：一整屏都是命令时，步骤日志就失去扫读能力。
	const [allItemsShown, setAllItemsShown] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	/** Once the reader scrolls the panel themselves, stop following the running step:
	 *  a streaming turn changes `currentId` repeatedly and the follow used to yank the
	 *  panel back mid-read (e.g. while browsing 本轮文件 or an opened file preview). */
	const userScrolled = useRef(false);
	// 相邻工具步骤归并为阶段，作为右栏的进度来源（issue #63）。
	const phases = useMemo(() => task ? progressPhases(task) : [], [task]);
	const stepLog = phases.length > 0 && !interrupted && !reminding;
	useEffect(() => {
		if (!progressOpen) return;
		// 只要读者自己碰过这个面板就不再跟随，否则流式期间 currentId 每次变化
		// 都会把人正在看的位置拽回去。本轮换轮时组件按 sourceMessageId 重挂载，守卫自然归零。
		if (userScrolled.current) return;
		const scroller = scrollRef.current;
		const active = scroller?.querySelector<HTMLElement>(".task-step.running");
		if (!scroller || !active) return;
		// 步骤行已经在可视区内就不要动它，避免无谓的滚动跳变。
		const box = scroller.getBoundingClientRect();
		const row = active.getBoundingClientRect();
		if (row.top >= box.top && row.bottom <= box.bottom) return;
		scroller.scrollTop = Math.max(0, row.top - box.top + scroller.scrollTop - scroller.clientHeight / 3);
	}, [phases, task?.id, progressOpen]);
	const preview = (path: string) => {
		// 打开预览会改变右栏布局，不要顺手把面板滚回当前步骤。
		userScrolled.current = true;
		const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
		onPreview(relative, relative.replace(/\\/g, "/").split("/").at(-1) ?? relative);
	};
	const empty = !task && !streaming && !interrupted && !reminding && !codemodeGroups.length;
	const state = interrupted ? "interrupted" : reminding ? "reminding" : task?.status ?? (streaming ? "running" : undefined);
	// 概览只描述本轮的步骤记录：已结束 / 进行中 / 失败 三类计数 + 总耗时。
	const tally = useMemo(() => {
		let done = 0, running = 0, failed = 0, longest = 0;
		for (const phase of phases) {
			if (phase.status === "running") running++;
			else if (phase.status === "failed") failed++;
			else done++;
			if (phase.durationMs) longest = Math.max(longest, phase.durationMs);
		}
		const startedAt = phases.length ? Math.min(...phases.map(phase => phase.startedAt || Infinity)) : 0;
		const endedAt = phases.length ? Math.max(...phases.map(phase => phase.endedAt ?? phase.startedAt)) : 0;
		return { done, running, failed, longest, total: phases.length, elapsed: startedAt && endedAt ? endedAt - startedAt : 0 };
	}, [phases]);
	const active = phases.find(phase => phase.status === "running");
	const settled = active ? phases.filter(phase => phase !== active) : phases;
	const overviewStatus = state === "running" ? (active ? "running" : "pending") : state === "failed" ? "failed" : state === "interrupted" ? "interrupted" : state === "reminding" ? "reminding" : stepLog && tally.total ? "done" : null;
	// 概览自动开合：运行中（含出错／中断／提醒）展开，本轮结束后收成一行把高度让给步骤；
	// 读者在本轮内手动开合过后以他的选择为准，新一轮会重置回默认值。
	const overviewDefault = overviewStatus === "done" ? false : true;
	const overviewOpen = overviewChoice ?? overviewDefault;
	const renderPhase = (phase: typeof phases[number], current: boolean) => {
		const items = phaseRecords(phase.steps, cwd);
		const duration = phase.durationMs !== undefined ? compactDuration(phase.durationMs) : undefined;
		// 每一步默认只占一行：状态 · 标题 · 类型徽标 · 耗时。命令列表按需展开。
		// 5 步的回合如果每次都把命令摊开，一个步骤就是一屏，右栏就此失去扫读能力。
		const kinds = (["read", "write", "run"] as const).filter(kind => items.some(item => stepKindTag(item.kind) === kind));
		const open = current ? !compactActive : expandedPhase === phase.id;
		return <li key={phase.id} className={`task-step ${phase.status}${current ? " current" : ""}`}>
			<span className="task-step-mark" aria-hidden="true">{phase.status === "done" ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg> : phase.status === "failed" ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg> : <svg className="task-step-spinner" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="29 9" /></svg>}</span>
			{current
				? <div className="task-step-current-row">
					<button type="button" className="task-step-title task-step-toggle" title={phaseHeadline(phase, locale)} aria-expanded={!compactActive} onClick={() => setCompactActive(value => !value)}><span>{phaseHeadline(phase, locale, true)}</span></button>
					<span className="task-step-meta"><span className="task-step-current">{t("taskStepCurrent")}</span></span>
				</div>
				: <button type="button" className="task-step-row" title={phaseHeadline(phase, locale)} aria-expanded={open} onClick={() => setExpandedPhase(value => value === phase.id ? null : phase.id)}>
					<span className="task-step-title">{phaseHeadline(phase, locale, true)}</span>
					<span className="task-step-meta">
						{items.length > 1 && <span className="task-step-count">{items.length}</span>}
						{duration && <span className="task-step-time">{duration}</span>}
						{items.length > 0 && <FiChevronRight className={open ? "open" : ""} />}
					</span>
				</button>}
			{kinds.length > 0 && <div className="task-step-kinds" aria-hidden="true">{kinds.map(kind => <i key={kind} className={`kind-${kind}`}>{t(kind === "read" ? "stepKindRead" : kind === "write" ? "stepKindWrite" : "stepKindRun")}</i>)}</div>}
			{open && items.length > 0 && (() => {
				// 文件与命令分开成组：一组是“看过什么”，一组是“跑过什么”，
				// 混在一列里最难读的恰恰是连续多行的 shell。
				const shown = allItemsShown === phase.id || items.length <= STEP_ITEMS_PREVIEW ? items : items.slice(0, STEP_ITEMS_PREVIEW);
				const hidden = items.length - shown.length;
				const groups = [{ id: "file", label: t("taskStepFiles"), rows: shown.filter(item => item.path) }, { id: "command", label: t("taskStepCommands"), rows: shown.filter(item => !item.path) }].filter(group => group.rows.length);
				// One group needs no heading; two groups read faster with one.
				const headed = groups.length > 1;
				return <ul className={`task-step-items${current ? " current" : ""}`}>
					{groups.map(group => <li key={group.id} className="task-step-group">
						{headed && <span className="task-step-group-label" aria-hidden="true">{group.label}</span>}
						<ul>
							{group.rows.map(item => <li key={item.key} className={item.path ? undefined : "command"}><button type="button" title={item.label} onClick={() => item.path ? preview(item.path) : window.dispatchEvent(new CustomEvent("pi:jump-tool", { detail: { messageId: item.messageId, toolCallId: item.toolCallId } }))}>{item.short}</button></li>)}
						</ul>
					</li>)}
					{hidden > 0 && <li className="task-step-more"><button type="button" aria-expanded={false} onClick={() => setAllItemsShown(phase.id)}>{t("taskStepsShowAll", { n: items.length })}</button></li>}
					{hidden <= 0 && items.length > STEP_ITEMS_PREVIEW && allItemsShown === phase.id && <li className="task-step-more"><button type="button" aria-expanded onClick={() => setAllItemsShown(null)}>{t("taskStepsShowLess")}</button></li>}
				</ul>;
			})()}
		</li>;
	};
	return <div className={`task-progress task-sections ${state ?? "empty"}`} tabIndex={-1} aria-label={t("taskProgress")}>
		{overviewStatus && !empty && <div className={`task-overview ${overviewStatus}${overviewOpen ? "" : " collapsed"}`}>
			<div className="task-overview-line"><span className="task-overview-state"><i aria-hidden="true" />{t(overviewStatus === "pending" ? "taskOverviewQueued" : overviewStatus === "running" ? "taskOverviewRunning" : overviewStatus === "failed" ? "taskStateFailed" : overviewStatus === "interrupted" ? "taskStateInterrupted" : overviewStatus === "reminding" ? "taskStateReminding" : "taskOverviewDone")}</span>
				<span className="task-overview-meta">{tally.total > 0 && <span>{t("taskStepsCount", { n: tally.total })}</span>}{tally.failed > 0 && <span className="failed">{t("taskOverviewFailedCount", { n: tally.failed })}</span>}{tally.elapsed >= 1000 && <span>{elapsedLabel(tally.elapsed / 1000)}</span>}</span>
				<button type="button" className="task-overview-toggle" aria-expanded={overviewOpen} aria-label={t(overviewOpen ? "collapseOverview" : "expandOverview")} title={t(overviewOpen ? "collapseOverview" : "expandOverview")} onClick={() => setOverviewChoice(!overviewOpen)}><FiChevronRight className={overviewOpen ? "open" : ""} /></button>
			</div>
			{overviewOpen && <div className="task-overview-track" aria-hidden="true">{phases.map(phase => <i key={phase.id} className={phase.status} style={{ flexGrow: Math.max(400, phase.durationMs ?? 0) }} />)}</div>}
		</div>}
		<div className="task-sections-scroll" ref={scrollRef} onPointerDown={() => { userScrolled.current = true; }} onWheel={() => { userScrolled.current = true; }} onTouchMove={() => { userScrolled.current = true; }} onKeyDown={event => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) userScrolled.current = true; }}>
			{empty ? <p className="task-panel-empty">{t("taskPanelEmpty")}</p> : <>
			<section className="task-section">
				<button type="button" className="task-section-heading" aria-expanded={progressOpen} onClick={() => setProgressOpen(value => !value)}><FiChevronRight className={progressOpen ? "open" : ""} />{t(stepLog ? "taskStepsHeading" : "taskProgressHeading")}{stepLog && <span className="task-section-count">{t("completedOfTotal", { done: tally.done, total: tally.total })}</span>}</button>
				{progressOpen && <div className="task-section-content">
					{stepLog ? (phases.length ? <ol className="task-step-log">{settled.map(phase => renderPhase(phase, false))}{active && renderPhase(active, true)}</ol> : <div className="task-section-empty"><p>{t(streaming ? "taskStepsPending" : "taskStepsEmpty")}</p></div>) : interrupted ? <div className="task-interrupted-hint"><strong>● {t("taskInterruptedTitle")}</strong><p>{t("taskInterruptedHint")}</p></div> : reminding ? null : <div className="task-section-empty"><p>{t(streaming ? "taskStepsPending" : "taskStepsEmpty")}</p></div>}
				</div>}
			</section>
			<CodemodeRecords groups={codemodeGroups} messages={live ? [...messages, live] : messages} conversationId={conversationId} send={send}/>
			</>}
		</div>
	</div>;
}
