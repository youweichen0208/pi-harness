import { RunningIndicator } from "./RunningIndicator";
import { useEffect, useState, type ReactNode } from "react";
import { FiChevronRight } from "react-icons/fi";
import { useChatT } from "../i18n";
import { processGroupState, type ProcessStats } from "../process-stats";
export { emptyProcessStats, type ProcessStats } from "../process-stats";
import { elapsedLabel } from "../bash-presentation";

/** One collapsible list per stretch of thinking/commands/reads between paragraphs.
 * Open while its turn is still on it or after a failure; rows stay mounted so jumps and search can reveal them. */
export function ProcessGroup({ stats, children }: { stats: ProcessStats; children: ReactNode }) {
	const t = useChatT();
	const [manual, setManual] = useState<boolean | null>(null);
	const single = stats.commands === 1 && !stats.reads && !stats.searches && !stats.thinking && !stats.failed && !stats.skipped;
	// Unresolved failures remain visible; successful retries use the normal success state.
	const open = single || (manual ?? (stats.running || stats.failed > 0));
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
	const state = processGroupState(stats);
	const passed = state === "ok";
	// 29a: a finished list drops its head and border entirely — the steps read as
	// the quiet text Claude Code prints between two paragraphs. Running and failed
	// lists keep a headless one-row summary so the state stays visible.
	const headless = !single && passed && !open;
	return <section className={`process-group ${state}${open ? " open" : ""}${single ? " single-command" : ""}${headless ? " headless" : ""}`}>
		{!single && !headless && <button type="button" className="process-group-head" aria-expanded={open} onClick={() => setManual(!open)}>
			<FiChevronRight className="process-group-chevron" aria-hidden="true" />
			<span className="process-group-summary"><span>{parts.join(" · ")}</span></span>
			{thought && <><span className="process-group-dot" aria-hidden="true">·</span><span className="process-group-thought">{thought}</span></>}
			{/* 29a: no "N failed" / "Completed" badge on the right — the ✗ rows and their
			   exit code already say it. Only a running turn shows its breathing dot. */}
			{stats.running && <span className="process-group-status">
				<RunningIndicator />{t("processRunning")}
			</span>}
		</button>}
		{headless && <button type="button" className="process-group-summary-line" aria-expanded={false} onClick={() => setManual(true)}>{parts.join(" · ")}{thought && <> · {thought}</>}</button>}
		<div className="process-list process-group-rows" hidden={!open}>{children}</div>
	</section>;
}
