import { useEffect, useState, type ReactNode } from "react";
import { FiChevronRight } from "react-icons/fi";
import { useT } from "../i18n";
import { failureRecovered, type ProcessStats } from "../process-stats";
export { emptyProcessStats, type ProcessStats } from "../process-stats";
import { elapsedLabel } from "../bash-presentation";

/** One collapsible list per stretch of thinking/commands/reads between paragraphs.
 * Open while its turn is still on it or after a failure; rows stay mounted so jumps and search can reveal them. */
export function ProcessGroup({ stats, children }: { stats: ProcessStats; children: ReactNode }) {
	const t = useT();
	const [manual, setManual] = useState<boolean | null>(null);
	const recovered = failureRecovered(stats);
	// Only a failure the turn stopped on asks for attention; recovered ones stay folded.
	const open = manual ?? (stats.live || stats.running || stats.failed > 0 && !recovered);
	const ids = stats.toolIds.join("\n");
	useEffect(() => {
		const reveal = (event: Event) => {
			const id = (event as CustomEvent<{ toolCallId?: string }>).detail?.toolCallId;
			if (id && ids.split("\n").includes(id)) setManual(true);
		};
		window.addEventListener("pi:reveal-tool", reveal);
		return () => window.removeEventListener("pi:reveal-tool", reveal);
	}, [ids]);
	const parts = [
		stats.commands && t(stats.commands === 1 ? "processRanCommand" : "processRanCommands", { n: stats.commands }),
		stats.reads && t(stats.reads === 1 ? "processReadFile" : "processReadFiles", { n: stats.reads }),
		stats.searches && t(stats.searches === 1 ? "processSearch" : "processSearches", { n: stats.searches }),
	].filter(Boolean) as string[];
	const thought = stats.thinking > 0 && (stats.thoughtMs >= 1000 ? t("processThought", { d: elapsedLabel(stats.thoughtMs / 1000) }) : t("processThoughtUnmeasured"));
	const state = stats.running ? "run" : stats.failed ? recovered ? "recovered" : "err" : stats.skipped ? "empty" : "ok";
	return <section className={`process-group ${state}${open ? " open" : ""}`}>
		<button type="button" className="process-group-head" aria-expanded={open} onClick={() => setManual(!open)}>
			<FiChevronRight className="process-group-chevron" aria-hidden="true" />
			<span className="process-group-summary">{parts.join(" · ")}</span>
			{thought && <><span className="process-group-dot" aria-hidden="true">·</span><span className="process-group-thought">{thought}</span></>}
			<span className="process-group-status">
				{stats.running ? <><i className="thinking-spinner" aria-hidden="true" />{t("processRunning")}</>
					: stats.failed ? t(recovered ? "processFailedRecovered" : "processFailed", { n: stats.failed })
						: stats.skipped ? t("toolNotExecuted") : t("processAllPassed")}
			</span>
		</button>
		<div className="process-list process-group-rows" hidden={!open}>{children}</div>
	</section>;
}
