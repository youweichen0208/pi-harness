import { LuChevronDown, LuCheck, LuCircle, LuTriangleAlert } from "react-icons/lu";
import type { ProcessGroup } from "../process-groups";
import { useT } from "../i18n";

export function ProcessSummary({ group, open, onToggle }: { group: ProcessGroup; open: boolean; onToggle: () => void }) {
	const t = useT();
	const details = [group.reads ? t("processRead", { n: group.reads }) : "", group.commands ? t("processCommands", { n: group.commands }) : "", group.edits ? t("processEdits", { n: group.edits }) : "", group.thinkingMs >= 1000 ? t("processThinking", { n: Math.round(group.thinkingMs / 1000) }) : ""].filter(Boolean).join(" · ");
	return <div className="process-overview">{!open && <div className="process-summary-header"><img src="/icon/1a-mark.svg" alt="" /><strong>pi</strong></div>}<button type="button" className={`process-summary ${group.failed ? "failed" : group.running ? "running" : "settled"}`} aria-expanded={open} onClick={onToggle}>
		<span className="process-summary-mark" aria-hidden="true">{group.failed ? <LuTriangleAlert /> : group.running ? <LuCircle /> : <LuCheck />}</span>
		<strong>{t(group.failed ? "processInterrupted" : group.running ? "processRunning" : "processFinished")}{group.calls > 0 && ` · ${t("processSteps", { n: group.calls })}`}</strong>
		{details && <span className="process-summary-detail">{details}</span>}
		<span className="process-summary-toggle">{t(open ? "processCollapse" : "processExpand")}<LuChevronDown className={open ? "open" : ""} /></span>
	</button></div>;
}
