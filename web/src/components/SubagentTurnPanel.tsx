import { createContext, useEffect, useState } from "react";
import { FiChevronRight, FiGitBranch, FiCheck, FiX, FiClock } from "react-icons/fi";
import { useT } from "../i18n";
import { subagentPresentation, type SubagentItemView } from "../subagent-presentation";
import { subagentErrorGroups, subagentFailed } from "../subagent-errors";
import type { UiToolCallBlock } from "../types";
import type { ToolView } from "./ToolCallBlock";
import { SubagentTaskDrawer } from "./SubagentTaskDrawer";

export interface SubagentTurnCall { block: UiToolCallBlock; view: ToolView }
export const SubagentTurnContext = createContext<ReadonlyMap<string, SubagentTurnCall[]>>(new Map());
export const subagentTerminal = (item: SubagentItemView) => ["completed", "failed", "cancelled"].includes(item.phase);
export function SubagentStatus({ item }: { item: SubagentItemView }) {
	const t = useT();
	const key = ({ queued: "toolQueued", running: "running", stopping: "subagentStopping", completed: "done", failed: "error", cancelled: "subagentCancelled" } as const)[item.phase];
	return <span className={`subagent-task-status ${item.phase}`}>{item.phase === "running" || item.phase === "stopping" ? <i className="thinking-spinner" /> : item.phase === "completed" ? <FiCheck /> : subagentFailed(item) ? <FiX /> : <FiClock />}{t(key)}</span>;
}
export function SubagentTurnPanel({ calls, fallback }: { calls: SubagentTurnCall[]; fallback: (call: SubagentTurnCall) => React.ReactNode }) {
	const t = useT();
	const [manualOpen, setOpen] = useState<boolean>();
	const [failuresOpen, setFailuresOpen] = useState(false);
	const [selected, setSelected] = useState<string>();
	const [now, setNow] = useState(Date.now());
	const entries = calls.map(call => {
		const output = call.view.result?.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") ?? call.view.liveOutput ?? "";
		const parsed = subagentPresentation(call.block.argumentsText ?? "", output, call.view.subagents, call.view.result?.subagents);
		const model = call.view.result && !parsed?.final ? undefined : parsed;
		return { ...call, output, model };
	});
	const rows = entries.flatMap(entry => entry.model?.items.map((item, index) => ({ item, entry, key: item.taskId ?? `${entry.block.id}:${index}` })) ?? []);
	const running = rows.some(row => !subagentTerminal(row.item));
	const open = manualOpen ?? (running || entries.some(entry => !entry.model));
	const failed = rows.filter(row => subagentFailed(row.item));
	const visible = rows.filter(row => !subagentFailed(row.item));
	const current = rows.find(row => row.key === selected);
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	useEffect(() => {
		const reveal = (event: Event) => {
			const id = (event as CustomEvent<{ toolCallId?: string }>).detail?.toolCallId;
			const row = rows.find(row => row.entry.block.id === id);
			if (row) { setOpen(true); if (subagentFailed(row.item)) setFailuresOpen(true); setSelected(row.key); }
		};
		window.addEventListener("pi:reveal-tool", reveal);
		return () => window.removeEventListener("pi:reveal-tool", reveal);
	}, [rows]);
	const renderRow = (row: typeof rows[number]) => {
		const item = row.item;
		const ms = item.durationMs ?? (item.startedAt ? now - item.startedAt : undefined);
		return <button type="button" className="subagent-task-row" key={row.key} onClick={() => setSelected(row.key)} data-task-id={row.key}>
			<SubagentStatus item={item} /><span className="subagent-task-label"><strong>{item.title || item.task || item.source}</strong><small>{item.sources?.map(source => source.name).join(" · ") || item.source}{item.tool ? ` · ${t(({ source_list: "subagentActivityList", source_read: "subagentActivityRead", source_search: "subagentActivitySearch", source_report: "subagentActivityReport" } as const)[item.tool])}` : ""}</small></span>
			<span className="subagent-task-time">{ms !== undefined ? `${Math.max(0, ms / 1000).toFixed(1)}s` : ""}</span><FiChevronRight />
		</button>;
	};
	return <div className="toolcall subagent-task-group" data-tool-call-id={calls[0].block.id}>
		<button type="button" className="subagent-task-group-head" aria-expanded={open} onClick={() => setOpen(!open)}><FiGitBranch /><strong>{t("subagentTasksTitle")}</strong><span>{t("subagentTaskCounts", { total: rows.length, running: rows.filter(row => !subagentTerminal(row.item)).length, done: rows.filter(row => row.item.phase === "completed").length, failed: failed.length })}</span><FiChevronRight className={open ? "open" : ""} /></button>
		{!visible.length && failed.length > 0 && <div className="subagent-task-failures subagent-task-all-failed"><p>{t("subagentAllAttemptsFailed")}</p></div>}
		{open && <div className="subagent-task-list">
			{visible.map(renderRow)}
			{failed.length > 0 && <div className="subagent-task-failures">
				<button type="button" onClick={() => setFailuresOpen(!failuresOpen)} aria-expanded={failuresOpen}>{t("subagentUnsuccessfulAttempts", { n: failed.length })}<FiChevronRight className={failuresOpen ? "open" : ""} /></button>
				{failuresOpen && subagentErrorGroups(failed.map(row => row.item)).map((group, index) => <div key={`${group.kind}:${group.items[0]?.taskId ?? index}`}>
					<p className="subagent-detail-note">{t(`subagentError_${group.kind}`)}</p>
					{failed.filter(row => group.items.includes(row.item)).map(renderRow)}
				</div>)}
			</div>}
			{entries.filter(entry => !entry.model).map(entry => <div key={entry.block.id}>{fallback(entry)}</div>)}
		</div>}
		{current && <SubagentTaskDrawer key={current.key} item={current.item} argumentsText={current.entry.block.argumentsText ?? ""} outputText={current.entry.output} onClose={() => setSelected(undefined)} />}
	</div>;
}
