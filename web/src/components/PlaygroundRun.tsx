import { useState, type ReactNode } from "react";
import { FiPlay, FiSquare } from "react-icons/fi";
import { useT } from "../i18n";
import { usePlaygroundHost } from "../playground-context";
import { runKey, startRun, stopRun, usePlaygroundRun } from "../playground-run-store";
import { CopyButton } from "./copy-button";

/**
 * A Run's result area.
 *
 * Shared by every entry point, because a Run looks the same wherever it was
 * started. `onSendToPi` is optional: a Note has no agent conversation, so it
 * gets the copy button and nothing else.
 *
 * The Run itself lives in `playground-run-store`, not here: the chat entry's
 * component is re-mounted when its message moves from the in-flight slot into
 * the settled list, and a Run must survive that.
 */
export function PlaygroundResult({ runKey: key, onSendToPi, stale = false, showCases = true }: { runKey: string; onSendToPi?: (text: string) => void; stale?: boolean; showCases?: boolean }) {
	const t = useT();
	const [expanded, setExpanded] = useState(true);
	const run = usePlaygroundRun(key);
	const running = run.phase === "running";
	const output = `${run.cases.length ? JSON.stringify(run.cases, null, 2) + "\n" : ""}${run.stdout}${run.stderr}`;
	const failed = run.cases.some(result => result.status === "failed" || result.status === "error") || !!run.error || run.timedOut || run.truncated || run.compileError || (run.exitCode !== null && run.exitCode !== 0);

	return <div className="playground-result" role="region" aria-label={t("playgroundRun")}>
		<button type="button" className="playground-result-head" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
			<span className={`playground-dot ${running ? "running" : failed ? "failed" : "ok"}`} aria-hidden="true" />
			<strong>{t(running ? "playgroundRunning" : run.stopped ? "pgRunStopped" : failed ? "pgRunFailed" : "pgRunFinished")}</strong>
			{stale && <span className="playground-badge stale">{t(run.cases.length ? "pgChanged" : "playgroundCodeChanged")}</span>}
			{run.timedOut && <span className="playground-badge">{t("playgroundTimedOut")}</span>}
			{run.truncated && <span className="playground-badge">{t("playgroundTruncated")}</span>}
			{!running && !run.error && <span className="playground-meta">{t("playgroundExitCode")} {run.exitCode ?? "-"} · {t("playgroundDuration")} {run.durationMs}ms</span>}
		</button>
		{!showCases && run.cases.length > 0 && <div className="method-summary scratch-run-summary" aria-live="polite">{t("pgPassed")} {run.cases.filter(c => c.status === "passed").length} · {t("pgFailed")} {run.cases.filter(c => c.status === "failed").length} · {t("pgError")} {run.cases.filter(c => c.status === "error").length} · {t("pgUnasserted")} {run.cases.filter(c => c.status === "unasserted").length}</div>}
		{expanded && <>
			{run.error && <div className="playground-notice" role="alert">{run.errorStatus === 429 ? t("playgroundBusy") : run.error}</div>}
			{run.needsProject && <div className="playground-hint" role="note">{t("playgroundSingleFileOnly")}</div>}
			{showCases && run.cases.length > 0 && <section className="method-results" aria-live="polite">
				<div className="method-summary">{t("pgPassed")} {run.cases.filter(c => c.status === "passed").length} · {t("pgFailed")} {run.cases.filter(c => c.status === "failed").length} · {t("pgError")} {run.cases.filter(c => c.status === "error").length} · {t("pgUnasserted")} {run.cases.filter(c => c.status === "unasserted").length} · {t("pgSkipped")} {run.cases.filter(c => c.status === "skipped").length}</div>
				{run.cases.map((result, index) => <div className={`method-result ${result.status}`} key={result.id}>
					<strong>{t("pgCase")} {index + 1} · {t(({ passed: "pgPassed", failed: "pgFailed", error: "pgError", unasserted: "pgUnasserted", skipped: "pgSkipped", pending: "pgPending", running: "pgRunning" } as const)[result.status])}</strong>
					<span className="playground-meta">{result.durationMs}ms</span>
					{"actual" in result && result.actual !== undefined && <pre>{t("pgActual")}: {result.actual}</pre>}
					{"expected" in result && result.expected !== undefined && <pre>{t("pgExpectedValue")}: {result.expected}</pre>}
					{"error" in result && result.error && <pre>{result.error}</pre>}
				</div>)}
			</section>}
			{run.stdout && <section className="playground-stream"><h4>{t("playgroundStdout")}</h4><pre>{run.stdout}</pre></section>}
			{run.stderr && <section className="playground-stream stderr"><h4>{t("playgroundStderr")}</h4><pre>{run.stderr}</pre></section>}
			{!running && !run.error && (
				<div className="playground-result-foot">
					<CopyButton text={output} label />
					{onSendToPi && <button type="button" className="playground-action" onClick={() => onSendToPi(fence(output))}>{t("playgroundSendToPi")}</button>}
				</div>
			)}
		</>}
	</div>;
}

/**
 * The Run control on a Python code block, with its result below it.
 *
 * A Run is not a sandbox, so the control is deliberately loud about *why* it is
 * unavailable rather than hidden: a missing Python 3, the setting being off and the
 * environment lock are three different problems with three different fixes.
 * Nothing here enters the model context — handing a result to pi is an explicit
 * click that only fills the composer.
 */
export function PlaygroundRun({ code, pre }: { code: string; pre?: ReactNode }) {
	const t = useT();
	const { status, conversationId, sendToPi } = usePlaygroundHost();
	const key = runKey(conversationId, code);
	const run = usePlaygroundRun(key);
	const started = run.phase === "running" || run.stdout !== "" || run.stderr !== "" || run.exitCode !== null || !!run.error || run.stopped;
	const running = run.phase === "running";
	const reason = !status
		? t("playgroundChecking")
		: status.locked
			? t("playgroundLocked")
			: !status.enabled
				? t("playgroundDisabled")
				: !status.python.available
					? [t("playgroundNoPython"), status.python.reason].filter(Boolean).join(" — ")
					: "";

	return <>
		<div className="codeblock-bar">
			<span>python</span>
			{running ? (
				<button type="button" className="playground-action" title={t("playgroundStop")} onClick={() => stopRun(key)}>
					<FiSquare aria-hidden="true" /><span>{t("playgroundStop")}</span>
				</button>
			) : (
				<button
					type="button"
					className="playground-action"
					disabled={!!reason}
					title={reason || t(started ? "playgroundRerun" : "playgroundRun")}
					aria-label={reason || t(started ? "playgroundRerun" : "playgroundRun")}
					onClick={() => void startRun(key, code)}
				>
					<FiPlay aria-hidden="true" /><span>{t(started ? "playgroundRerun" : "playgroundRun")}</span>
				</button>
			)}
			<CopyButton text={code} label />
		</div>
		{pre}
		{started && <PlaygroundResult runKey={key} onSendToPi={sendToPi} />}
	</>;
}

/** Hand the output over as a fenced block so pi sees it as code, not prose. */
function fence(output: string): string {
	return `\`\`\`\n${output.replace(/\n$/, "")}\n\`\`\`\n`;
}
