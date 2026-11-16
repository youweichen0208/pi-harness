import type { ClientMessage, UiState } from "../types";
import { useT } from "../i18n";
import { RunningIndicator } from "./RunningIndicator";

/** Snapshot-owned status survives reconnects and follows the selected conversation. */
export function RunRecoveryStatus({ state, connected, send }: { state: Pick<UiState, "runRecovery"> | null; connected: boolean; send: (message: ClientMessage) => boolean }) {
	const t = useT();
	const recovery = state?.runRecovery;
	if (!recovery) return null;
	const active = recovery.phase !== "stopped";
	const reason = recovery.reason === "length" ? "runRecoveryLength" : recovery.reason === "tool-text" ? "runRecoveryToolText" : "runRecoveryRepetition";
	const detail = recovery.detail === "exhausted" ? "runRecoveryExhausted"
		: recovery.detail === "unsafe" ? "runRecoveryUnsafe"
		: recovery.detail === "thinking-only" ? "runRecoveryThinkingOnly"
		: recovery.detail === "cancelled" ? "runRecoveryCancelled"
		: recovery.detail === "failed" ? "runRecoveryFailed" : "runRecoveryStopped";
	return <div className="compaction-status run-recovery-status" role="status" data-recovery-reason={recovery.reason} data-recovery-phase={recovery.phase}>
		{active && connected && <RunningIndicator />}
		<span>{active ? t(!connected ? "workDisconnected" : recovery.phase === "stopping" ? "runRecoveryStopping" : reason) : t(detail)}{recovery.attempt > 0 && ` · ${recovery.attempt}/${recovery.limit}`}</span>
		{active && <button type="button" disabled={!connected} onClick={() => send({ type: "abort" })}>{t("stop")}</button>}
	</div>;
}
