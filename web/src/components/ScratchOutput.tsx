import { FiCheckCircle, FiAlertCircle, FiClock, FiSquare } from "react-icons/fi";
import type { PlaygroundRunState } from "../playground-run-store";
import { useT } from "../i18n";

/** Compact output for the script and its current function invocation. */
export function ScratchOutput({ program, cases, stale, executing }: { executing: boolean; program: PlaygroundRunState; cases?: PlaygroundRunState; stale: boolean }) {
	const t = useT();
	const runs = [program, ...(cases ? [cases] : [])];
	const running = executing || runs.some(run => run.phase === "running");
	const stopped = runs.some(run => run.stopped);
	const failed = runs.some(run => run.error || run.compileError || run.timedOut || run.truncated || (run.exitCode !== null && run.exitCode !== 0) || run.cases.some(item => item.status === "failed" || item.status === "error"));
	const actual = cases?.cases[0];
	const errors = [...new Set(runs.flatMap(run => [run.errorStatus === 429 ? t("playgroundBusy") : run.error, run.stderr, run.timedOut ? t("playgroundTimedOut") : "", run.truncated ? t("playgroundTruncated") : "", ...run.cases.map(item => "error" in item ? item.error : "")]).filter(Boolean))];
	const StatusIcon = running ? FiClock : stopped ? FiSquare : failed ? FiAlertCircle : FiCheckCircle;
	const stdout = runs.map(run => run.stdout).filter(Boolean).join("\n");
	return <section className="scratch-output" aria-live="polite">
		<div className={`lc-result-summary ${running || stopped ? "neutral" : failed ? "error" : "success"}`}><StatusIcon aria-hidden="true" /><strong>{t(running ? "playgroundRunning" : stopped ? "pgRunStopped" : failed ? "pgRunError" : "pgRunFinished")}</strong>{stale && <span>{t("pgPreviousResult")}</span>}</div>
		{actual && "actual" in actual && actual.actual !== undefined && <div className="lc-result-value"><label>{t("pgActual")}</label><pre>{actual.actual}</pre></div>}
		{stdout && <div className="lc-result-value playground-stream"><label>{t("pgScriptOutput")}</label><pre>{stdout}</pre></div>}
		{errors.map((error, index) => <pre className="method-validation" key={index}>{error}</pre>)}
	</section>;
}
