import { FiCheckCircle, FiAlertCircle } from "react-icons/fi";
import { commandDuration } from "../bash-presentation";
import type { CommandTurn } from "../command-turns";
import { useT } from "../i18n";

export function CommandTurnSummary({ summary }: { summary: CommandTurn }) {
	const t = useT();
	const passed = !summary.failed && !summary.skipped;
	const parts = [
		t("commandTurnCount", { n: summary.commands }),
		passed ? t("commandTurnPassed") : [summary.failed && t("commandTurnFailed", { n: summary.failed }), summary.skipped && t("commandTurnSkipped", { n: summary.skipped })].filter(Boolean).join(" · "),
		summary.lines !== undefined && t("commandTurnLines", { n: summary.lines }),
		summary.durationMs !== undefined && t("commandTurnDuration", { time: commandDuration(summary.durationMs) }),
	].filter(Boolean);
	return <div className={`command-turn-summary ${passed ? "passed" : "attention"}`}>
		{passed ? <FiCheckCircle aria-hidden="true" /> : <FiAlertCircle aria-hidden="true" />}
		<span>{parts.join(" · ")}</span>
	</div>;
}
