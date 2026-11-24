import { highlightLine } from "../hljs-lite";
import { copyText } from "../clipboard";
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiChevronDown, FiChevronRight, FiCopy, FiTerminal } from "react-icons/fi";
import { commandReading, consecutiveAttempts } from "../command-reading";
import { useChatT } from "../i18n";
import { BackgroundContext, WorkspacePathContext } from "../workspace-context";
import { bashCommand } from "../bash-steps";
import { commandPresentation, commandPreview, isLikelyErrorLine, commandDuration, elapsedLabel } from "../bash-presentation";
import { latestOutputLine, outputSilenceSeconds } from "../live-tool-output";
import type { UiToolCallBlock } from "../types";
import { toolDuration, type ToolView } from "./ToolCallBlock";
import { ToolOutputDownload } from "./ToolOutputDownload";

type Item = { currentStep?: boolean; messageId?: string; block: UiToolCallBlock; view: ToolView };
const seconds = (ms: number) => ms < 1000 ? "" : commandDuration(ms);

/** Seconds since mount while `active` — live elapsed timer for running rows. */
function useLiveSeconds(active: boolean) {
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		if (!active) { setElapsed(0); return; }
		const started = Date.now();
		const update = () => setElapsed(Math.floor((Date.now() - started) / 1000));
		update();
		const timer = window.setInterval(update, 1000);
		return () => window.clearInterval(timer);
	}, [active]);
	return elapsed;
}
/** Run state of one call; shared with the process group header. */
export function stateOf(view: ToolView): "ok" | "err" | "run" | "empty" {
	if (view.background) return ["foreground", "background"].includes(view.background.state) ? "run" : view.background.state === "done" ? "ok" : "err";
	if (view.result) return view.result.isError ? "err" : "ok";
	if (view.status && !view.status.running) return view.status.isError ? "err" : "ok";
	// Calls in an aborted/errored message never executed (issue #66) — show
	// them as empty rather than a misleading error mark.
	if (view.abandoned) return "empty";
	return view.streaming ? "run" : "err";
}

function commandAttemptKey(item: Item) {
	return item.view.background ? item.block.id : bashCommand(item.block.argumentsText) ?? item.block.argumentsText ?? item.block.id;
}

/** Presentation only: tool IDs and the authoritative result lookup stay intact. */
/** Latest attempt of each command, as its row shows it (retries collapse into one row). */
export function latestAttemptStates(items: Item[], _cwd: string) {
	return consecutiveAttempts(items, commandAttemptKey)
		.map(group => ({ state: stateOf(group[group.length - 1].view), view: group[group.length - 1].view }));
}

/** `flat`: rows only, inside a process group that owns the header and collapse. */
export function BashGroup({ items, onKill, active = false, flat = false }: { items: Item[]; onKill?: () => void; active?: boolean; flat?: boolean }) {
	const t = useChatT();
	const cwd = useContext(WorkspacePathContext);
	const attempts = consecutiveAttempts(items, commandAttemptKey);
	const [open, setOpen] = useState(active);
	useEffect(() => setOpen(active), [active]);
	const [all, setAll] = useState(false);
	const [revealed, setRevealed] = useState<string>();
	const latest = attempts.map(group => group[group.length - 1]);
	const failed = latest.filter(({ view }) => stateOf(view) === "err").length;
	const running = latest.some(({ view }) => stateOf(view) === "run");
	const skipped = latest.length > 0 && latest.every(({ view }) => view.abandoned && !view.result && !view.status);
	const state = failed ? "err" : running ? "run" : skipped ? "empty" : "ok";
	const durations = items.map(({ view }) => toolDuration(view));
	const measured = durations.every((ms) => ms !== undefined);
	useEffect(() => {
		const jump = (event: Event) => {
			const id = (event as CustomEvent<{ toolCallId?: string }>).detail?.toolCallId;
			if (items.some(({ block }) => block.id === id)) { setOpen(true); setAll(true); setRevealed(id); }
		};
		window.addEventListener("pi:reveal-tool", jump);
		return () => window.removeEventListener("pi:reveal-tool", jump);
	}, [items]);
	return <section className={`bash-group ${state} ${!open ? "historical-step" : ""}`}>
		{!flat && <button type="button" className="bash-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
			<span className={`bash-state ${state}`} aria-label={t(failed ? "error" : running ? "running" : skipped ? "toolNotExecuted" : "done")}>{failed ? "✗" : running ? <FiTerminal className="bash-row-icon" aria-hidden="true" /> : skipped ? "−" : "✓"}</span>
			<strong>{!open ? commandReading(commandPresentation(bashCommand(items[0].block.argumentsText) ?? "", cwd).command).title : t(running ? "bashGroupRunning" : "bashGroupCount", { n: items.length })}</strong>{!open && items.length > 1 && <span className="bash-group-count">{t("changesCommands", { n: items.length })}</span>}
			{failed > 0 && <span className="bash-state err">{t("bashGroupFailed", { n: failed })}</span>}
			{measured && seconds(durations.reduce<number>((sum, ms) => sum + (ms ?? 0), 0)) && <span className="bash-group-duration">{seconds(durations.reduce<number>((sum, ms) => sum + (ms ?? 0), 0))}</span>}
			{open ? <FiChevronDown /> : <FiChevronRight />}
		</button>}
		{(flat || open) && <div className="bash-group-items">
			{!all && attempts.length > 8 && <button type="button" className="bash-group-more" onClick={() => setAll(true)}>{t("bashGroupEarlier", { n: attempts.length - 8 })}</button>}
			{(all ? attempts : attempts.slice(-8)).map(group => group.length === 1 ? <BashRow key={group[0].block.id} {...group[0]} onKill={onKill} compact={flat} revealed={revealed === group[0].block.id} /> : <BashRow key={group[0].block.id} {...group[group.length - 1]} onKill={onKill} compact={flat} revealed={group.some(item => item.block.id === revealed)} attempts={group.length} history={<div className="bash-attempt-history">{group.slice(0, -1).map(item => <BashRow key={item.block.id} {...item} revealed={item.block.id === revealed} historical />)}</div>} />)}
		</div>}
	</section>;
}

function BashRow({ block, view, currentStep, onKill, revealed, messageId, attempts, historical, history, compact }: Item & { onKill?: () => void; revealed: boolean; attempts?: number; historical?: boolean; history?: ReactNode; compact?: boolean }) {
	const t = useChatT();
	const cwd = useContext(WorkspacePathContext);
	const { control } = useContext(BackgroundContext);
	const task = view.background;
	const state = historical && !view.result ? "empty" : stateOf(view);
	// In a process group the group opens on failure; rows stay compact until clicked or revealed.
	const [open, setOpen] = useState(state === "err" && !compact);
	const [all, setAll] = useState(false);
	const [requestOpen, setRequestOpen] = useState(false);
	const [wrapOutput, setWrapOutput] = useState(true);
	const [copyError, setCopyError] = useState<"command" | "output" | null>(null);
	const [copied, setCopied] = useState<"command" | "output" | null>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout>>();
	useEffect(() => () => clearTimeout(copyTimer.current), []);
	useEffect(() => { if (state === "err" && !compact || revealed) setOpen(true); }, [state, revealed, compact]);
	useEffect(() => {
		const jump = (event: Event) => { if ((event as CustomEvent).detail?.toolCallId === block.id) { setOpen(true); if ((event as CustomEvent).detail?.search) { setAll(true); setRequestOpen(true); } } };
		window.addEventListener("pi:reveal-tool", jump);
		return () => window.removeEventListener("pi:reveal-tool", jump);
	}, [block.id]);
	const command = bashCommand(block.argumentsText) ?? block.argumentsText ?? "bash";
	const display = commandPresentation(command, cwd);
	const subtitle = commandPreview(command, cwd);
	const commandLines = display.command.trimEnd().split(/\r?\n/);
	// Shell card: real bash line breaks, not a JSON-escaped string.
	const rawCommandLines = command.trimEnd().split(/\r?\n/);
	const commandHtml = useMemo(() => highlightLine(command, "bash"), [command]);
	const requestTimeout = useMemo(() => { try { const a = JSON.parse(block.argumentsText ?? "{}"); return typeof a.timeout === "number" ? a.timeout : undefined; } catch { return undefined; } }, [block.argumentsText]);
	// Long commands clamp the Shell command to a 6-line preview with an expand toggle.
	const longRequest = rawCommandLines.length > 6;
	const output = task ? [task.output, task.error].filter(Boolean).join("\n") : view.result?.content.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("") ?? view.liveOutput ?? "";
	const lines = output ? output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
	// issue #106: a running command shows its elapsed time and latest output
	// line right on the row, and tails (not heads) the output when expanded.
	const mountedSeconds = useLiveSeconds(state === "run" && view.connected !== false);
	const liveSeconds = task && state === "run" && view.connected !== false ? Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000)) : mountedSeconds;
	const quietSeconds = outputSilenceSeconds(view.lastOutputAt, Date.now());
	const feedback = task?.state === "background" ? "" : state === "run"
		? view.connected === false ? t("bashConnectionLost")
			: quietSeconds !== undefined ? t("bashNoOutputFor", { time: elapsedLabel(quietSeconds) })
				: !view.liveOutput && liveSeconds >= 30 ? t("bashWaitingFirstOutput")
				: view.lastOutputAt === undefined || !view.liveOutput ? t("waitingOutput") : ""
		: !view.result && view.status && !view.status.running ? t("bashCommandFinished") : "";
	const shimmer = state === "run" && view.connected !== false ? "streaming-color" : undefined;
	const runningStats = view.connected === false ? t("bashConnectionLost") : liveSeconds > 0 ? `${t("processRunning")} ${elapsedLabel(liveSeconds)}` : t("processRunning");
	const liveLine = state === "run" && !open ? latestOutputLine(task?.output ?? view.liveOutput ?? "") : "";
	const shownLines = all ? lines : state === "run" ? lines.slice(-6) : lines.slice(0, 6);
	const lineOffset = !all && state === "run" ? lines.length - shownLines.length : 0;
	const details = view.result?.details as { exitCode?: number; fullOutputPath?: string; truncation?: { truncated?: boolean } } | undefined;
	const exitCode = task?.exitCode ?? details?.exitCode ?? view.status?.exitCode;
	const truncated = task?.fullOutputPath || details?.fullOutputPath || details?.truncation?.truncated || view.result?.content.some((part) => part.type === "text" && part.truncated);
	const copy = async (kind: "command" | "output", doc: Document) => {
		setCopyError(null);
		try { await copyText(kind === "command" ? command : output, doc); setCopied(kind); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(null), 1500); } catch { setCopied(null); setCopyError(kind); }
	};
	return <div className={`bash-row ${state}`} data-tool-call-id={block.id} data-msg-id={messageId} onMouseEnter={() => window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId: block.id } }))} onMouseLeave={() => window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId: null } }))}>
		<button type="button" className="bash-row-head" title={command} aria-expanded={open} onClick={() => setOpen(!open)}>
			<span className={`bash-state ${state}`} aria-label={t(state === "run" ? "running" : state === "err" ? "error" : state === "empty" && view.abandoned ? "toolNotExecuted" : "done")}>{state === "err" ? "✗" : state === "empty" ? "−" : <FiTerminal className="bash-row-icon" aria-hidden="true" />}</span>
			<span className="bash-row-subtitle" title={command}><span className={shimmer ?? (state === "ok" && currentStep ? "current-command-step" : undefined)}>{subtitle}</span></span>
			{state !== "ok" && <>
				{attempts && <span className="bash-attempt-count">{t("commandAttempts", { n: attempts })}</span>}
				{commandLines.length > 1 && <span className="bash-extra-lines">{t("bashExtraLines", { n: commandLines.length - 1 })}</span>}
				{!open && feedback && <span className="bash-live-line"><span className={shimmer}>{feedback}</span></span>}
				{!feedback && liveLine && <span className="bash-live-line" title={liveLine}>{liveLine}</span>}
				{compact ? <span className={`bash-row-stats${shimmer ? " streaming-color" : ""}`}>{state === "run" ? runningStats : state === "empty" && view.abandoned ? t("toolNotExecuted") : state === "err" && exitCode !== undefined ? `exit ${exitCode}` : (toolDuration(view) ?? 0) >= 100 ? commandDuration(toolDuration(view)!) : t("toolLineCount", { n: lines.length })}</span> : <span className={`bash-row-stats${shimmer ? " streaming-color" : ""}`}>{state === "run" ? runningStats : state === "empty" && view.abandoned ? t("toolNotExecuted") : exitCode !== undefined && state === "err" ? t("bashExitCode", { n: exitCode }) : t("toolLineCount", { n: lines.length })}{toolDuration(view) !== undefined && seconds(toolDuration(view)!) ? ` · ${seconds(toolDuration(view)!)}` : ""}</span>}
			</>}
			{/* GPT-style rows reserve the chevron slot on every state and fade it in on hover/focus/expand, so revealing it never nudges the command. */}
			{open ? <FiChevronDown /> : <FiChevronRight />}
		</button>
		{task && <div className="bash-row-actions">
			{task.state === "background" && <span>{t("backgroundRunning")}{!output && " · " + t("backgroundEmpty")}</span>}
			{task.state === "stopped" && <span>{t("cancelled")}</span>}
			{task.state === "interrupted" && <span>{t("backgroundInterrupted")}</span>}
			{task.exitCode !== undefined && <span>{t("bashExitCode", { n: task.exitCode })}</span>}
			{task.state === "foreground" && <button disabled={view.connected === false} onClick={() => control?.(task.id, "detach")}>{t("backgroundDetach")}</button>}
			{state === "run" && <button disabled={view.connected === false} onClick={() => control?.(task.id, "stop")}>{t("backgroundStop")}</button>}
		</div>}
		{open && <div className="bash-row-body">
			{feedback && <div className="bash-output-feedback"><span className={shimmer}>{feedback}</span></div>}
			{display.directory && <div className="bash-row-directory">{t("bashGroupCwd", { path: display.directory })}</div>}
			<section className="bash-detail-card bash-shell-card">
				<header className="bash-detail-heading bash-shell-heading"><strong>Shell</strong><div className="bash-detail-controls">
					{requestTimeout !== undefined && <span className="bash-request-meta">timeout {requestTimeout}s</span>}
					<button type="button" className="bash-shell-copy" aria-label={t(copyError === "command" ? "copyFailed" : copied === "command" ? "copied" : "bashCopyCommand")} title={t("bashCopyCommand")} onClick={event => void copy("command", event.currentTarget.ownerDocument)}><FiCopy aria-hidden="true" />{t(copyError === "command" ? "copyFailed" : copied === "command" ? "copied" : "bashCopyCommand")}</button>
					<button type="button" aria-pressed={wrapOutput} onClick={() => setWrapOutput(value => !value)}>{t("toolWrap")}</button>
					<button type="button" className="bash-shell-copy" aria-label={t(copyError === "output" ? "copyFailed" : copied === "output" ? "copied" : "bashCopyOutput")} title={t("bashCopyOutput")} disabled={!output} onClick={event => void copy("output", event.currentTarget.ownerDocument)}><FiCopy aria-hidden="true" />{t(copyError === "output" ? "copyFailed" : copied === "output" ? "copied" : "bashCopyOutput")}</button>
				</div></header>
				<div className="bash-shell-command"><span className="bash-detail-prompt" aria-hidden="true">$</span><pre className={`bash-request-code bash-syntax${longRequest && !requestOpen ? " clamped" : ""}`} dangerouslySetInnerHTML={{ __html: commandHtml }} /></div>
				{longRequest && <button type="button" className="bash-group-more" aria-expanded={requestOpen} onClick={() => setRequestOpen(value => !value)}>{requestOpen ? t("collapseCode") : t("bashRemainingLines", { n: rawCommandLines.length - 6 })}</button>}
				<div className="bash-response-card">
					{lines.length > 0 && <div className={`bash-numbered-output${wrapOutput ? " wrap" : ""}`} data-msg-id={view.result?.id}>{shownLines.map((line, i) => <div key={lineOffset + i} className={`bash-numbered-line${isLikelyErrorLine(line) ? " error" : ""}`}><code>{line}</code></div>)}</div>}
					{lines.length > 6 && <button type="button" className="bash-group-more" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? t("collapseCode") : t("expandCode")}</button>}
					{((truncated && view.result?.toolOutputUrl) || (state === "run" && !task && onKill)) && <div className="bash-row-actions">
						{truncated && view.result?.toolOutputUrl && <ToolOutputDownload url={view.result.toolOutputUrl} />}
						{state === "run" && !task && onKill && <button type="button" onClick={onKill}>{t("stopBash")}</button>}
					</div>}
				</div>
				{(state === "err" || state === "empty") && <footer className={`bash-shell-status ${state}`}>{state === "err" ? `✗ ${exitCode !== undefined ? t("bashExitCode", { n: exitCode }) : t("error")}` : `− ${t("toolNotExecuted")}`}</footer>}
			</section>
			{history}
		</div>}
	</div>;
}
