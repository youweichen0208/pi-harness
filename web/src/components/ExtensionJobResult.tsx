import { useState } from "react";
import { useT } from "../i18n";
import type { ExtensionJob } from "../types";
import { extensionErrorMessage } from "../extensions-presentation";

/** One compact result per package; the native diagnostic remains available in the log. */
export function ExtensionJobResult({ job, onRetry }: { job: ExtensionJob; onRetry?: () => void }) {
	const t = useT();
	const [showLog, setShowLog] = useState(false);
	const failed = job.phase === "error" || job.phase === "partial";
	const title = job.phase === "running" ? "extRunning" : job.phase === "partial" ? "extPartial" : job.phase === "error" ? "extFailed"
		: job.results?.some(result => result.status === "warning") ? "extUpdateWarnings" : "extDone";
	const labels = { updated: "extResultUpdated", unchanged: "extResultUnchanged", skipped: "extResultSkipped", warning: "extResultWarning", error: "extResultError" } as const;
	const reasons = { offline: "extSkipOffline", pinned: "extSkipPinned", protected: "extSkipProtected", untrusted: "extSkipUntrusted", local: "extSkipLocal", unverified: "extUpdateUnverified" } as const;
	const revision = (value: string) => /^[a-f\d]{40,64}$/i.test(value) ? value.slice(0, 7) : value;
	return <div className={`ext-job ${job.phase === "error" ? "ext-error" : ""}`} data-phase={job.phase}>
		<div><strong role="status">{t(title)}</strong><button aria-expanded={showLog} onClick={() => setShowLog(value => !value)}>{t(showLog ? "extHideLog" : "extLog")}</button></div>
		{job.error && <p>{extensionErrorMessage(job.error, t)}</p>}
		{!!job.results?.length && <ul className="ext-update-results">{job.results.map(result => <li key={result.id} data-status={result.status}>
			<div className="ext-update-result-heading"><strong>{result.name}</strong><span>{t(result.scope === "user" ? "extPersonal" : "extProject")}</span><span className="ext-update-status">{t(labels[result.status])}</span></div>
			{(result.from || result.to) && <code title={[result.from, result.to].filter(Boolean).join(" → ")}>{result.from && revision(result.from)}{result.to && result.to !== result.from && <> → {revision(result.to)}</>}</code>}
			{result.reason && <p>{t(reasons[result.reason])}</p>}
			{result.message && (result.status === "warning" || result.status === "error") && <p>{extensionErrorMessage(result.message, t)}</p>}
		</li>)}</ul>}
		{failed && onRetry && <button onClick={onRetry}>{t("extRetry")}</button>}
		{showLog && <pre>{job.log}</pre>}
	</div>;
}
