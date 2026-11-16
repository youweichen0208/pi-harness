import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";
import type { ClientMessage, OmpTaskResponse, UiMessage, UiOmpTask } from "../types";
import { ToolOutputDownload } from "./ToolOutputDownload";
import { useT } from "../i18n";
import { isTopDialog, useDialogFocus } from "../use-dialog-focus";
import { randomUuid } from "../uuid";
import { Markdown } from "./Markdown";
import { RunningIndicator } from "./RunningIndicator";

type Send = (message: ClientMessage) => boolean;
const active = (task: UiOmpTask) => task.status === "running" || task.status === "pending";
const statusKey = { pending: "ompTaskPending", running: "running", completed: "done", failed: "error", aborted: "subagentCancelled", interrupted: "ompTaskInterrupted" } as const;

export function OmpTasksPanel({ tasks, conversationId, send, enabled = true, heading = true }: { tasks: UiOmpTask[]; conversationId: string; send: Send; enabled?: boolean; heading?: boolean }) {
	const t = useT(), [selected, setSelected] = useState<{ id: string; conversationId: string; opener: HTMLElement }>();
	const task = enabled && selected?.conversationId === conversationId ? tasks.find(item => item.id === selected?.id) : undefined;
	useEffect(() => { if (!task) setSelected(undefined); }, [task]);
	useEffect(() => {
		const move = (event: Event) => { if ((event as CustomEvent<HTMLElement>).detail?.contains(selected?.opener ?? null)) setSelected(undefined); };
		window.addEventListener("pi:chat-surface-moving", move);
		return () => window.removeEventListener("pi:chat-surface-moving", move);
	}, [selected]);
	if (!tasks.length) return null;
	return <section className="task-section omp-tasks" aria-label={t("ompTasks")}>
		{heading && <h3 className="task-section-heading">{t("ompTasks")} · {tasks.length}</h3>}
		<ul className="omp-task-list">{tasks.map(item => <li key={item.id}><button type="button" onClick={event => setSelected({ id: item.id, conversationId, opener: event.currentTarget })}>
			<span>{active(item) && <RunningIndicator />}<strong>{item.title}</strong></span>
			<small>{t(statusKey[item.status])}{item.currentTool ? ` · ${item.currentTool}` : ""}{item.durationMs !== undefined ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}</small>
		</button></li>)}</ul>
		{task && selected && <OmpTaskDrawer key={`${conversationId}:${task.id}`} task={task} conversationId={conversationId} send={send} target={selected.opener.closest("dialog") ?? selected.opener.ownerDocument.body} onClose={() => setSelected(undefined)} />}
	</section>;
}

function OmpTaskDrawer({ task, conversationId, send, target, onClose }: { task: UiOmpTask; conversationId: string; send: Send; target: HTMLElement; onClose: () => void }) {
	const owner = target.ownerDocument;
	const t = useT(), box = useDialogFocus(true, owner);
	const [messages, setMessages] = useState<UiMessage[]>([]), [error, setError] = useState(false), [busy, setBusy] = useState(false), [stopping, setStopping] = useState(false);
	const [more, setMore] = useState(false), [truncated, setTruncated] = useState(false);
	const [tab, setTab] = useState(active(task) ? "process" : "result");
	const pending = useRef(new Map<string, { action: "detail" | "stop"; time: number }>());
	const cursor = useRef(0), hasMore = useRef(false), current = useRef(task); current.current = task;
	const request = useRef<(action?: "detail" | "stop") => void>(() => {});
	useEffect(() => {
		const ask = (action: "detail" | "stop" = "detail") => {
			if ([...pending.current.values()].some(item => item.action === action)) return;
			const requestId = randomUuid(); pending.current.set(requestId, { action, time: Date.now() });
			if (action === "stop") setStopping(true); else setBusy(true);
			setError(false);
			if (!send({ type: "omp_task_request", conversationId, taskId: task.id, requestId, action, cursor: action === "detail" ? cursor.current : undefined })) {
				pending.current.delete(requestId); setError(true); setBusy(false); setStopping(false);
			}
		};
		request.current = ask;
		const receive = (event: Event) => {
			const result = (event as CustomEvent<OmpTaskResponse>).detail;
			if (result.conversationId !== conversationId || result.taskId !== task.id) return;
			const operation = pending.current.get(result.requestId); if (!operation) return;
			pending.current.delete(result.requestId);
			if (operation.action === "stop") setStopping(false); else setBusy(false);
			if (result.error) { setError(true); return; }
			if (result.messages && result.nextCursor !== undefined) {
				cursor.current = result.nextCursor; hasMore.current = result.hasMore === true; setMore(hasMore.current);
				setMessages(previous => {
					const byId = new Map(previous.map(message => [message.id, message]));
					for (const message of result.messages!) byId.set(message.id, message);
					return [...byId.values()];
				});
				if (result.truncated) setTruncated(true);
			}
		};
		window.addEventListener("pi:omp-task-response", receive); ask();
		const timer = setInterval(() => {
			for (const [id, operation] of pending.current) if (Date.now() - operation.time > 15000) {
				pending.current.delete(id); setError(true); if (operation.action === "stop") setStopping(false); else setBusy(false);
			}
			if (active(current.current) && !hasMore.current) ask();
		}, 2000);
		return () => { clearInterval(timer); pending.current.clear(); window.removeEventListener("pi:omp-task-response", receive); request.current = () => {}; };
	}, [conversationId, task.id, send]);
	useEffect(() => { request.current(); }, [task.status]);
	useEffect(() => {
		const key = (event: KeyboardEvent) => { if (event.key === "Escape" && isTopDialog(box.current)) { event.preventDefault(); event.stopPropagation(); onClose(); } };
		owner.addEventListener("keydown", key, true); return () => owner.removeEventListener("keydown", key, true);
	}, [box, onClose, owner]);
	const shown = tab === "result" ? messages.filter(message => message.role === "assistant") : messages;
	return createPortal(<div className="subagent-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
		<div className="subagent-drawer" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={task.title}>
			<header><div><small>{t("ompTasks")}</small><h2>{task.title}</h2></div><button type="button" aria-label={t("close")} onClick={onClose}><FiX /></button></header>
			<div className="subagent-drawer-meta"><span>{t(statusKey[task.status])}</span><span>{task.agent}</span>{task.tokens !== undefined && <span>{task.tokens} tokens</span>}{task.cost !== undefined && <span>${task.cost.toFixed(4)}</span>}{task.canStop && <button type="button" disabled={stopping} onClick={() => request.current("stop")}>{t("subagentStopTask")}</button>}</div>
			<nav className="subagent-drawer-tabs" aria-label={t("subagentTaskDetail")}><button type="button" aria-pressed={tab === "process"} onClick={() => setTab("process")}>{t("subagentProcessTab")}</button><button type="button" aria-pressed={tab === "result"} onClick={() => setTab("result")}>{t("subagentResultTab")}</button></nav>
			<div className="subagent-drawer-content omp-task-transcript">
				{task.task && <details><summary>{t("subagentTaskLabel")}</summary><p>{task.task}</p></details>}
				{error && <p role="status">{t("ompTaskUnavailable")} <button type="button" onClick={() => request.current()}>{t("retry")}</button></p>}
				{shown.map(message => <article key={message.id}>{message.toolOutputUrl && <ToolOutputDownload url={message.toolOutputUrl} compact />}{message.content.map((block, index) => {
					if (block.type === "text" && typeof block.text === "string") return <Markdown key={index} text={block.text} />;
					if (block.type === "thinking" && typeof block.thinking === "string") return <details key={index}><summary>{t("thinking")}</summary><Markdown text={block.thinking} /></details>;
					if (block.type === "toolCall" && typeof block.name === "string") return <details key={index}><summary>{block.name}</summary><pre>{typeof block.argumentsText === "string" ? block.argumentsText : ""}</pre></details>;
					return null;
				})}</article>)}
				{truncated && <p role="status">{t("ompTaskTruncated")}</p>}
				{busy && <p role="status">{t("loading")}</p>}
				{more && <button type="button" disabled={busy} onClick={() => request.current()}>{t("ompTaskMore")}</button>}
			</div>
		</div>
	</div>, target);
}
