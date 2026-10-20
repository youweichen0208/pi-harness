import type { ReactNode } from "react";
import { useState } from "react";
import { FiPlay, FiSquare } from "react-icons/fi";
import { useT } from "../i18n";
import { usePlaygroundHost } from "../playground-context";
import { runKey, startRun, stopRun, usePlaygroundRun } from "../playground-run-store";
import { CopyButton } from "./copy-button";

/**
 * The Run control and its result area, rendered under a Java code block.
 *
 * A Run is not a sandbox, so the control is deliberately loud about *why* it is
 * unavailable rather than hidden: a missing JDK, the setting being off and the
 * environment lock are three different problems with three different fixes.
 * Nothing here enters the model context — handing a result to pi is an explicit
 * click that only fills the composer.
 *
 * The Run itself lives in `playground-run-store`, not here: this component is
 * re-mounted when its message moves from the in-flight slot into the settled
 * list, and a Run must survive that.
 */
export function PlaygroundRun({ code, pre }: { code: string; pre?: ReactNode }) {
	const t = useT();
	const { status, conversationId, sendToPi } = usePlaygroundHost();
	const [expanded, setExpanded] = useState(true);
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
	const output = `${run.stdout}${run.stderr}`;
	const failed = !!run.error || run.timedOut || run.truncated || run.compileError || (run.exitCode !== null && run.exitCode !== 0);

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
					onClick={() => { setExpanded(true); void startRun(key, code); }}
				>
					<FiPlay aria-hidden="true" /><span>{t(started ? "playgroundRerun" : "playgroundRun")}</span>
				</button>
			)}
			<CopyButton text={code} label />
		</div>
		{pre}
		{started && (
			<div className="playground-result" role="region" aria-label={t("playgroundRun")}>
				<button type="button" className="playground-result-head" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
					<span className={`playground-dot ${running ? "running" : failed ? "failed" : "ok"}`} aria-hidden="true" />
					<strong>{t(running ? "playgroundRunning" : "playgroundRun")}</strong>
					{run.timedOut && <span className="playground-badge">{t("playgroundTimedOut")}</span>}
					{run.truncated && <span className="playground-badge">{t("playgroundTruncated")}</span>}
					{!running && !run.error && <span className="playground-meta">{t("playgroundExitCode")} {run.exitCode ?? "-"} · {t("playgroundDuration")} {run.durationMs}ms</span>}
				</button>
				{expanded && <>
					{run.error && <div className="playground-notice" role="alert">{run.error}</div>}
					{run.stdout && <section className="playground-stream"><h4>{t("playgroundStdout")}</h4><pre>{run.stdout}</pre></section>}
					{run.stderr && <section className="playground-stream stderr"><h4>{t("playgroundStderr")}</h4><pre>{run.stderr}</pre></section>}
					{!running && !run.error && (
						<div className="playground-result-foot">
							<CopyButton text={output} label />
							<button type="button" className="playground-action" onClick={() => sendToPi(fence(output))}>{t("playgroundSendToPi")}</button>
						</div>
					)}
				</>}
			</div>
		)}
	</>;
}

/** Hand the output over as a fenced block so pi sees it as code, not prose. */
function fence(output: string): string {
	return `\`\`\`\n${output.replace(/\n$/, "")}\n\`\`\`\n`;
}
