import { formatBashOutput, formattedOutputCanExpand } from "../bash-output-format";
import { BashFormattedOutput } from "./BashFormattedOutput";
import { highlightLine } from "../hljs-lite";
import { copyText } from "../clipboard";
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiChevronDown, FiChevronRight, FiCopy, FiTerminal } from "react-icons/fi";
import { commandReading, consecutiveAttempts } from "../command-reading";
import { useChatT, useI18n } from "../i18n";
import { WorkspacePathContext } from "../workspace-context";
import { bashCommand } from "../bash-steps";
import { hasNumberedPipelineOutput, hasSearchSourceNumbers, searchSourceNumberParts, commandPresentation, commandPreview, isLikelyErrorLine, compactCommandLabel, commandDuration, elapsedLabel } from "../bash-presentation";
import { latestOutputLine } from "../live-tool-output";
import type { UiToolCallBlock } from "../types";
import { toolDuration, type ToolView } from "./ToolCallBlock";
import { ToolOutputDownload } from "./ToolOutputDownload";

type Item = { messageId?: string; block: UiToolCallBlock; view: ToolView };
const seconds = (ms: number) => ms < 1000 ? "" : commandDuration(ms);

/** Seconds since mount while `active` — live elapsed timer for running rows. */
function useLiveSeconds(active: boolean) {
	const started = useRef(Date.now());
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		if (!active) return;
		const update = () => setElapsed(Math.floor((Date.now() - started.current) / 1000));
		update();
		const timer = window.setInterval(update, 1000);
		return () => window.clearInterval(timer);
	}, [active]);
	return elapsed;
}
/** Run state of one call; shared with the process group header. */
export function stateOf(view: ToolView): "ok" | "err" | "run" | "empty" {
	if (view.result) return view.result.isError ? "err" : "ok";
	if (view.status && !view.status.running) return view.status.isError ? "err" : "ok";
	// Calls in an aborted/errored message never executed (issue #66) — show
	// them as empty rather than a misleading error mark.
	if (view.abandoned) return "empty";
	return view.streaming ? "run" : "err";
}

/** Presentation only: tool IDs and the authoritative result lookup stay intact. */
/** Latest attempt of each command, as its row shows it (retries collapse into one row). */
export function latestAttemptStates(items: Item[], cwd: string) {
	return consecutiveAttempts(items, item => bashCommand(item.block.argumentsText) ?? item.block.argumentsText ?? item.block.id)
		.map(group => ({ state: stateOf(group[group.length - 1].view), view: group[group.length - 1].view }));
}

/** `flat`: rows only, inside a process group that owns the header and collapse. */
export function BashGroup({ items, onKill, active = false, flat = false }: { items: Item[]; onKill?: () => void; active?: boolean; flat?: boolean }) {
	const t = useChatT();
	const cwd = useContext(WorkspacePathContext);
	const attempts = consecutiveAttempts(items, item => bashCommand(item.block.argumentsText) ?? item.block.argumentsText ?? item.block.id);
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
			<span className={`bash-state ${state}`} aria-label={t(failed ? "error" : running ? "running" : skipped ? "toolNotExecuted" : "done")}>{failed ? "✗" : running ? <i className="thinking-spinner" /> : skipped ? "−" : "✓"}</span>
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

function BashRow({ block, view, onKill, revealed, messageId, attempts, historical, history, compact }: Item & { onKill?: () => void; revealed: boolean; attempts?: number; historical?: boolean; history?: ReactNode; compact?: boolean }) {
	const t = useChatT();
	const cwd = useContext(WorkspacePathContext);
	const state = historical && !view.result ? "empty" : stateOf(view);
	const { locale } = useI18n();
	// In a process group the group opens on failure; rows stay compact until clicked or revealed.
	const [open, setOpen] = useState(state === "err" && !compact);
	const [all, setAll] = useState(false);
	const [fullCommand, setFullCommand] = useState(false);
	const [wrapOutput, setWrapOutput] = useState(true);
	const [copyError, setCopyError] = useState<"command" | "output" | null>(null);
	const [copied, setCopied] = useState<"command" | "output" | null>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout>>();
	useEffect(() => () => clearTimeout(copyTimer.current), []);
	useEffect(() => { if (state === "err" && !compact || revealed) setOpen(true); }, [state, revealed, compact]);
	useEffect(() => {
		const jump = (event: Event) => { if ((event as CustomEvent).detail?.toolCallId === block.id) { setOpen(true); if ((event as CustomEvent).detail?.search) { setAll(true); setFullCommand(true); } } };
		window.addEventListener("pi:reveal-tool", jump);
		return () => window.removeEventListener("pi:reveal-tool", jump);
	}, [block.id]);
	const command = bashCommand(block.argumentsText) ?? block.argumentsText ?? "bash";
	const display = commandPresentation(command, cwd);
	const searchNumbers = useMemo(() => hasSearchSourceNumbers(command) || hasNumberedPipelineOutput(command), [command]);
	const reading = commandReading(display.command, locale === "en");
	const commandLines = display.command.trimEnd().split(/\r?\n/);
	const rawCommandLines = command.trimEnd().split(/\r?\n/);
	const visibleCommand = fullCommand ? command : rawCommandLines.slice(0, 6).join("\n");
	const commandHtml = useMemo(() => highlightLine(visibleCommand, "bash"), [visibleCommand]);
	const output = view.result?.content.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("") ?? view.liveOutput ?? "";
	const format = useMemo(() => formatBashOutput(command, output, !!view.result && state !== "err"), [command, output, view.result, state]);
	const formatted = format.kind !== "terminal";
	const lines = output ? output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
	// issue #106: a running command shows its elapsed time and latest output
	// line right on the row, and tails (not heads) the output when expanded.
	const liveSeconds = useLiveSeconds(state === "run");
	const runningStats = liveSeconds > 0 ? `${t("processRunning")} ${elapsedLabel(liveSeconds)}` : t("processRunning");
	const liveLine = state === "run" && !open ? latestOutputLine(view.liveOutput ?? "") : "";
	const shownLines = all ? lines : state === "run" ? lines.slice(-6) : lines.slice(0, 6);
	const lineOffset = !all && state === "run" ? lines.length - shownLines.length : 0;
	const details = view.result?.details as { exitCode?: number; fullOutputPath?: string; truncation?: { truncated?: boolean } } | undefined;
	const exitCode = details?.exitCode ?? view.status?.exitCode;
	const truncated = details?.fullOutputPath || details?.truncation?.truncated || view.result?.content.some((part) => part.type === "text" && part.truncated);
	const copy = async (kind: "command" | "output", doc: Document) => {
		setCopyError(null);
		try { await copyText(kind === "command" ? command : output, doc); setCopied(kind); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(null), 1500); } catch { setCopied(null); setCopyError(kind); }
	};
	return <div className={`bash-row ${state}`} data-tool-call-id={block.id} data-msg-id={messageId} onMouseEnter={() => window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId: block.id } }))} onMouseLeave={() => window.dispatchEvent(new CustomEvent("pi:tool-hover", { detail: { toolCallId: null } }))}>
		<button type="button" className="bash-row-head" title={command} aria-expanded={open} onClick={() => setOpen(!open)}>
			<span className={`bash-state ${state}`} aria-label={t(state === "run" ? "running" : state === "err" ? "error" : state === "empty" && view.abandoned ? "toolNotExecuted" : "done")}>{state === "run" ? <i className="thinking-spinner" /> : state === "err" ? "✗" : state === "empty" ? "−" : "✓"}</span>
			<code className="bash-inline-command" title={command}>{commandPreview(command, cwd)}</code>
			{attempts && <span className="bash-attempt-count">{t("commandAttempts", { n: attempts })}</span>}{reading.title !== compactCommandLabel(reading.command) && <code className="bash-command-secondary">{reading.command}</code>}
			{commandLines.length > 1 && <span className="bash-extra-lines">{t("bashExtraLines", { n: commandLines.length - 1 })}</span>}
			{liveLine && <span className="bash-live-line" title={liveLine}>{liveLine}</span>}
			{compact ? <span className="bash-row-stats">{state === "run" ? runningStats : state === "empty" && view.abandoned ? t("toolNotExecuted") : state === "err" && exitCode !== undefined ? `exit ${exitCode}` : (toolDuration(view) ?? 0) >= 100 ? commandDuration(toolDuration(view)!) : t("toolLineCount", { n: lines.length })}</span> : <span className="bash-row-stats">{state === "run" ? runningStats : state === "empty" && view.abandoned ? t("toolNotExecuted") : exitCode !== undefined && state === "err" ? t("bashExitCode", { n: exitCode }) : t("toolLineCount", { n: lines.length })}{toolDuration(view) !== undefined && seconds(toolDuration(view)!) ? ` · ${seconds(toolDuration(view)!)}` : ""}</span>}
			{open ? <FiChevronDown /> : <FiChevronRight />}
		</button>
		{open && <div className="bash-row-body">
			{display.directory && <div className="bash-row-directory">{t("bashGroupCwd", { path: display.directory })}</div>}
			<section className="bash-detail-command">
				<header className="bash-detail-heading"><strong><FiTerminal aria-hidden="true" />{t("command")}</strong><div className="bash-detail-controls"><button type="button" onClick={event => void copy("command", event.currentTarget.ownerDocument)}><FiCopy aria-hidden="true" />{t(copyError === "command" ? "copyFailed" : copied === "command" ? "copied" : "bashCopyCommand")}</button>{rawCommandLines.length > 6 && <button type="button" aria-expanded={fullCommand} onClick={() => setFullCommand(value => !value)}>{t(fullCommand ? "collapseCode" : "bashExpandFullCommand")}</button>}</div></header>
				<div className="bash-command-with-prompt"><span className="bash-detail-prompt" aria-hidden="true">&gt;</span><pre className="bash-full-command bash-syntax" dangerouslySetInnerHTML={{ __html: commandHtml }} /></div>
				{!fullCommand && rawCommandLines.length > 6 && <button type="button" className="bash-group-more" onClick={() => setFullCommand(true)}>{t("bashRemainingLines", { n: rawCommandLines.length - 6 })}</button>}
			</section>
			{lines.length > 0 && <header className="bash-detail-heading bash-output-heading"><strong>{t("output")}</strong><div className="bash-detail-controls">{!formatted && <button type="button" aria-pressed={wrapOutput} onClick={() => setWrapOutput(value => !value)}>{t("toolWrap")}</button>}<button type="button" disabled={!output} onClick={event => void copy("output", event.currentTarget.ownerDocument)}><FiCopy aria-hidden="true" />{t(copyError === "output" ? "copyFailed" : copied === "output" ? "copied" : "bashCopyOutput")}</button></div></header>}
			{formatted && <BashFormattedOutput format={format} all={all} />}
			{lines.length > 0 && !formatted && <div className={`bash-numbered-output${wrapOutput ? " wrap" : ""}`} data-msg-id={view.result?.id}>{shownLines.map((line, i) => <div key={lineOffset + i} className={`bash-numbered-line${isLikelyErrorLine(line) ? " error" : ""}`}><code><OutputColor text={line} searchNumbers={searchNumbers} /></code></div>)}</div>}
			{(formatted ? formattedOutputCanExpand(format) : lines.length > 6) && <button type="button" className="bash-group-more" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? t("collapseCode") : t("expandCode")}</button>}
			<div className="bash-row-actions">
				{truncated && view.result?.toolOutputUrl && <ToolOutputDownload url={view.result.toolOutputUrl} />}
				<button type="button" title={t("bashOpenTerminalHint")} onClick={() => window.dispatchEvent(new CustomEvent("pi-harness:plugin-run-command", { detail: { title: compactCommandLabel(commandLines[0]), command } }))}>{t("bashOpenTerminal")}</button>
				{state === "run" && onKill && <button type="button" onClick={onKill}>{t("stopBash")}</button>}
			</div>
			{history}
		</div>}
	</div>;
}

/** Small, conservative accents; React escapes every part and preserves the source text. */
function OutputColor({ text, searchNumbers = false }: { text: string; searchNumbers?: boolean }) {
	const source = searchNumbers ? searchSourceNumberParts(text) : null;
	if (source) return <>{source.prefix}<OutputColor text={source.rest.trimStart()} /></>;
	if (isLikelyErrorLine(text)) return <>{text}</>;
	const stat = /^(\s*.+?)(\s+\|\s+\d+\s+)([+\-]+)(\s*)$/.exec(text);
	if (stat) return <>{stat[1]}{stat[2]}{stat[3].split(/(\++|-+)/).filter(Boolean).map((part, i) => <span key={i} className={part[0] === "+" ? "bash-color-add" : "bash-color-delete"}>{part}</span>)}{stat[4]}</>;
	return <>{text.split(/(\b\d+ insertions?\(\+\)|\b\d+ deletions?\(-\)|\b(?:PASS|passed|SUCCESS)\b)/g).map((part, i) => <span key={i} className={/^\d+ insertions?/.test(part) || /^(PASS|passed|SUCCESS)$/.test(part) ? "bash-color-add" : /^\d+ deletions?/.test(part) ? "bash-color-delete" : undefined}>{part}</span>)}</>;
}
