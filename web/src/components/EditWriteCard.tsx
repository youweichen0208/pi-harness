import { useEffect, useMemo, useContext, useState } from "react";
import { FiChevronRight, FiMoreHorizontal } from "react-icons/fi";
import type { UiToolCallBlock } from "../types";
import { useChatT } from "../i18n";
import { WorkspacePathContext } from "../workspace-context";
import { outputPath } from "../task-outputs";
import { editWriteChange, type ChangeLine, type EditWriteChange } from "../edit-write-presentation";
import { highlightLine, langFromPath } from "../hljs-lite";
import { ChangeSummaryCard } from "./ChangeSummaryCard";
import type { ToolView } from "./ToolCallBlock";

type Item = { block: UiToolCallBlock; view: ToolView };

function status(item: Item) {
	const error = item.view.result?.isError || item.view.status?.isError;
	// Calls in an aborted/errored message that never got a result were never
	// executed (issue #66) — not "running", not "queued".
	if (item.view.abandoned && !item.view.result && !item.view.status) return "skipped";
	return error ? "err" : item.view.result || item.view.status ? "done" : item.view.streaming ? "running" : "pending";
}

function Lines({ lines, path }: { lines: ChangeLine[]; path: string }) {
	const lang = langFromPath(path);
	// 只给小一列行号：新行存在就显示新行号，否则退回旧行号。
	// 之前并排渲染 `旧 新` 两列，看着就是每个行号写了两遍（`85 85`、`87 -`），
	// 而读者要的只是「这一段在文件的哪一行」。
	return <div className="change-lines">{lines.map((line, index) => <div key={index} className={`change-line ${line.marker === "+" ? "add" : line.marker === "-" ? "del" : "context"}`}><span className="change-old">{line.newLine ?? line.oldLine ?? ""}</span><span className="change-marker">{line.marker === "-" ? "−" : line.marker}</span><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightLine(line.text, lang) || "&#8203;" }} /></div>)}</div>;
}

function ChangeBody({ change, state, path, toolId }: { change: EditWriteChange; state: string; path: string; toolId: string }) {
	const t = useChatT();
	const [expanded, setExpanded] = useState(false);
	if (!change.error && !change.empty && state === "done") return <div className="change-card-body"><ChangeSummaryCard inlineDiff files={[{
		path, added: change.added, removed: change.removed, counted: true,
		lines: change.hunks.flatMap(hunk => hunk.lines), unlocated: change.fromArguments,
		truncated: change.diffTruncated, toolIds: [toolId],
	}]} /></div>;
	const allLines = change.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
	let remaining = expanded ? Infinity : 12;
	// 头部已经显示 `+N −M`，hunk 头已经显示行号／函数名，diff 行本身也带红绿和
	// `+`/`−` 标记。再单独列一行「删除 N · 新增 N」是把同一件事说三遍，正文从这里开始。
	const failure = change.errorText.split("\n").find((line) => line.trim()) || t("changeFailed");
	return <div className="change-card-body">
		{change.error && <div className="change-error">{failure}</div>}
		{change.empty ? <div className="change-empty">{change.error ? t("changeNoOriginal") : change.kind === "write" ? `${t("emptyFile")} (${change.path.split("/").at(-1)})` : state === "done" ? t("changeNoDiff") : state === "skipped" ? t("changeNotExecuted") : t("changeWaiting")}</div> : change.hunks.map((hunk, index) => {
			if (remaining <= 0) return null;
			const visible = hunk.lines.slice(0, remaining);
			remaining -= visible.length;
			return <div className="change-hunk" key={index}><div className="change-hunk-head">{change.error ? change.kind === "write" ? t("changeAttemptedWrite") : t("changeOriginal") : change.kind === "write" ? t("changeWrittenLines", { n: change.added }) : change.fromArguments ? t("changeReplacement") : t("changeAtLine", { n: hunk.line })}{hunk.functionName && <span> · {hunk.functionName}</span>}</div><Lines lines={visible} path={change.path} /></div>;
		})}
		{change.diffTruncated && <div className="change-empty">{t("truncated")}</div>}
		{allLines > 12 && <button type="button" className="change-more" onClick={() => setExpanded((value) => !value)}>{expanded ? t("collapseCode") : t("expandRemainingLines", { n: allLines - 12 })}</button>}
	</div>;
}

export function EditWriteCard({ item, compact = false, retried = false, live = false }: { item: Item; compact?: boolean; retried?: boolean; live?: boolean }) {
	const t = useChatT();
	const change = useMemo(() => editWriteChange(item.block, item.view.result), [item.block, item.view.result]);
	// Show the change directly, including historical edits; an explicit collapse wins.
	const [manual, setManual] = useState<boolean | null>(null);
	const running = !retried && status(item) === "running";
	const open = manual ?? (!change?.empty && (running || live || status(item) === "done"));
	useEffect(() => { if (running) setManual(null); }, [running]);
	useEffect(() => {
		const onJump = (event: Event) => {
			if ((event as CustomEvent<{ toolCallId?: string }>).detail?.toolCallId === item.block.id) setManual(true);
		};
		window.addEventListener("pi:jump-tool", onJump);
		return () => window.removeEventListener("pi:jump-tool", onJump);
	}, [item.block.id]);
	const cwd = useContext(WorkspacePathContext);
	if (!change) return null;
	const state = retried ? "retried" : status(item);
	const noDiff = change.kind === "edit" && change.empty && !change.error && state === "done";
	// 卡片标题栏只给工作区内的相对路径：一张 964px 宽的卡片里，
	// `/Users/youweichen/projects/pi-web-ui/` 这 35 个字符会把真正要看的那段
	// （`docs/ui-design.md`）挤到后面去。完整路径保留在悬停说明里，打开文件、
	// 高亮语言判定仍然用原值。工作区外的文件保持绝对路径——相对化后反而是错的。
	const absolute = change.path || item.block.name;
	// 末尾斜杠在某些调用传目录时会出现，渲染前去掉。
	const trimmed = absolute.replace(/\/+$/, "") || absolute;
	const path = outputPath(trimmed, cwd);
	return <div className={`change-card ${state}`} data-tool-call-id={item.block.id} onMouseEnter={() => window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId: item.block.id } }))} onMouseLeave={() => window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId: null } }))}>
		<div className="change-card-head">
			<button type="button" className="change-card-toggle" aria-expanded={open && !noDiff} disabled={noDiff} onClick={() => setManual(!open)}>{!noDiff && <FiChevronRight className={open ? "open" : ""} />}<span className={`change-state ${state}`} aria-label={retried ? t("changeRetried") : state === "err" ? t("error") : state === "done" ? t("done") : state === "skipped" ? t("toolNotExecuted") : state === "running" ? t("running") : t("toolQueued")}><i /></span><span className="change-verb">{item.block.name === "edit" ? t("changeEdit") : t("changeWrite")}</span><code title={absolute}>{path}</code></button>
			<span className="change-counts">{!change.error && <>{change.added > 0 && <span className="add">+{change.added}</span>}{change.removed > 0 && <span className="del">−{change.removed}</span>}</>}</span>
			<details className="change-raw"><summary aria-label={t("more")}><FiMoreHorizontal /></summary><div><strong>{t("changeRawArgs")}</strong><pre>{item.block.argumentsText}</pre>{change.output && <><strong>{t("changeRawOutput")}</strong><pre>{change.output}</pre></>}</div></details>
		</div>
		{open && !noDiff && <ChangeBody change={change} state={state} path={path} toolId={item.block.id} />}
	</div>;
}

export function EditWriteGroup({ items, retriedIds }: { items: Item[]; retriedIds?: ReadonlySet<string> }) {
	const t = useChatT();
	const [open, setOpen] = useState(true);
	useEffect(() => {
		const onJump = (event: Event) => {
			const id = (event as CustomEvent<{ toolCallId?: string }>).detail?.toolCallId;
			if (id && items.some((item) => item.block.id === id)) setOpen(true);
		};
		window.addEventListener("pi:jump-tool", onJump);
		return () => window.removeEventListener("pi:jump-tool", onJump);
	}, [items]);
	const changes = items.map(({ block, view }) => editWriteChange(block, view.result));
	const added = changes.reduce((sum, change) => sum + (change?.added ?? 0), 0);
	const removed = changes.reduce((sum, change) => sum + (change?.removed ?? 0), 0);
	const failed = items.some((item) => status(item) === "err" && !retriedIds?.has(item.block.id));
	// Skipped calls (never executed, issue #66) conclude the group — it must
	// not linger in "running" forever.
	const done = items.every((item) => ["done", "err", "skipped"].includes(status(item)));
	const skipped = items.every((item) => status(item) === "skipped");
	const verb = items.every((item) => item.block.name === "edit") ? t("changeEdit") : items.every((item) => item.block.name === "write") ? t("changeWrite") : t("taskChanges");
	return <div className={`change-group ${failed ? "err" : done ? "done" : "running"}`}><button type="button" className="change-group-head" aria-expanded={open} onClick={() => setOpen(!open)}><FiChevronRight className={open ? "open" : ""} /><strong>{verb} {items.length} {t("taskFiles")}</strong><span className="change-counts">{added > 0 && <span className="add">+{added}</span>}{removed > 0 && <span className="del">−{removed}</span>}</span><span className="change-state">{failed ? t("error") : skipped ? t("toolNotExecuted") : done ? t("done") : t("running")}</span></button>{open && <div className="change-group-items">{items.map((item) => <EditWriteCard key={item.block.id} item={item} compact retried={retriedIds?.has(item.block.id)} />)}</div>}</div>;
}
