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
export function PlaygroundResult({ runKey: key, onSendToPi, stale = false }: { runKey: string; onSendToPi?: (text: string) => void; stale?: boolean }) {
	const t = useT();
	const [expanded, setExpanded] = useState(true);
	const run = usePlaygroundRun(key);
	const running = run.phase === "running";
	const output = `${run.stdout}${run.stderr}`;
	const failed = !!run.error || run.timedOut || run.truncated || run.compileError || (run.exitCode !== null && run.exitCode !== 0);

	return <div className="playground-result" role="region" aria-label={t("playgroundRun")}>
		<button type="button" className="playground-result-head" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
			<span className={`playground-dot ${running ? "running" : failed ? "failed" : "ok"}`} aria-hidden="true" />
			<strong>{t(running ? "playgroundRunning" : "playgroundRun")}</strong>
			{stale && <span className="playground-badge stale">{t("playgroundCodeChanged")}</span>}
			{run.timedOut && <span className="playground-badge">{t("playgroundTimedOut")}</span>}
			{run.truncated && <span className="playground-badge">{t("playgroundTruncated")}</span>}
			{!running && !run.error && <span className="playground-meta">{t("playgroundExitCode")} {run.exitCode ?? "-"} · {t("playgroundDuration")} {run.durationMs}ms</span>}
		</button>
		{expanded && <>
			{run.error && <div className="playground-notice" role="alert">{run.error}</div>}
			{run.needsProject && <div className="playground-hint" role="note">{t("playgroundSingleFileOnly")}</div>}
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
 * The Run control on a Java code block, with its result below it.
 *
 * A Run is not a sandbox, so the control is deliberately loud about *why* it is
 * unavailable rather than hidden: a missing JDK, the setting being off and the
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
				: !status.jdk.available
					? [t("playgroundNoJdk"), status.jdk.reason].filter(Boolean).join(" — ")
					: "";

	return <>
		<div className="codeblock-bar">
			<span>java</span>
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
