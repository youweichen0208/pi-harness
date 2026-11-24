import type { UiState, ToolStatus } from "../types";
import { useEffect, useRef, useState } from "react";
import { useChatT } from "../i18n";
import { conversationWait, type WaitStage } from "../waiting-indicator";

function WaitingIndicator({ stage, onStop }: { stage: WaitStage; onStop?: () => void }) {
	const t = useChatT();
	const started = useRef(Date.now());
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		const update = () => setElapsed(Date.now() - started.current);
		const appearance = window.setTimeout(update, stage.delay);
		const timer = window.setInterval(update, 250);
		return () => { window.clearTimeout(appearance); window.clearInterval(timer); };
	}, [stage.delay]);
	if (elapsed < stage.delay) return null;
	const seconds = Math.floor(elapsed / 1000);
	return <div className="waiting-indicator" role="status">
		<span className="waiting-label">{t(stage.label)}</span>
		{seconds >= 4 && <span className="waiting-duration" aria-live="off">{seconds < 60 ? t("waitSeconds", { n: seconds }) : t("waitMinutes", { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, "0") })}</span>}
		{seconds >= 60 && onStop && <button className="waiting-stop" onClick={onStop}>· {t("waitStop")}</button>}
	</div>;
}

/** Shared presentation; native retry, compaction and silence notices take precedence. */
export function ConversationWorkingStatus({ state, connected, silenceNotified, toolStatuses, onStop }: {
	state: Pick<UiState, "messages" | "streamingMessage" | "isStreaming" | "conversationId" | "recovery" | "runRecovery"> & Partial<Pick<UiState, "queue">>;
	connected: boolean; silenceNotified: boolean; toolStatuses: ReadonlyMap<string, ToolStatus>; onStop?: () => void;
}) {
	const t = useChatT();
	const completed = new Map([...toolStatuses].filter(([, s]) => !s.running && (!s.conversationId || s.conversationId === state.conversationId)));
	const messages = state.streamingMessage ? [...state.messages.filter(m => m.id !== state.streamingMessage?.id), { ...state.streamingMessage, role: "assistant" }] : state.messages;
	const stage = conversationWait(messages, completed);
	if (!state.isStreaming || silenceNotified || state.runRecovery && state.runRecovery.phase !== "stopped" || state.recovery && [state.recovery.compaction, state.recovery.retry, state.recovery.summary, state.recovery.branch].some(Boolean)) return null;
	if (!connected) return <div className="agent-working disconnected" role="status">{t("workDisconnected")}</div>;
	return stage && <WaitingIndicator key={`${state.conversationId}:${stage.key}:${stage.label}`} stage={stage} onStop={onStop} />;
}
