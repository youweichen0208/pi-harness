import { UiIcon } from "./UiIcon";
import { useEffect, useState } from "react";
import type { ClientMessage } from "../types";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";
import { LONG_THINKING_MS, thinkingOnlySince } from "../long-thinking";

/** Long thinking without a reply or tool call: offer stop / stop-and-clarify (#76). Never acts on its own. */
export function LongThinkingStatus({ chat, send }: { chat: ChatState; send: (message: ClientMessage) => boolean }) {
	const t = useT();
	const state = chat.state;
	const since = state?.isStreaming ? thinkingOnlySince(state.messages, state.streamingMessage) : undefined;
	const [now, setNow] = useState(Date.now());
	const [dismissed, setDismissed] = useState<number>();
	const [clarify, setClarify] = useState<string>();
	useEffect(() => {
		if (since === undefined) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [since]);
	// Send the clarification only after the stop has settled, so it starts a new turn instead of steering the aborted one.
	useEffect(() => {
		if (!clarify || !state || state.conversationId !== clarify || state.isStreaming) return;
		setClarify(undefined);
		send({ type: "prompt", text: t("longThinkingClarifyPrompt") });
	}, [clarify, state?.isStreaming, state?.conversationId]);
	if (!chat.ready || !state || since === undefined || chat.agentSilence || dismissed === since) return null;
	if (state.recovery && Object.values(state.recovery).some(Boolean)) return null;
	const seconds = Math.max(0, Math.floor((now - since) / 1000));
	if (seconds * 1000 < LONG_THINKING_MS) return null;
	const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	return <div className="agent-silence model" role="status"><span className="agent-silence-label"><UiIcon name="warning" /> {t("longThinking", { duration })}</span><span className="agent-silence-actions"><button type="button" disabled={!!clarify} onClick={() => send({ type: "abort" })}>{t("stop")}</button><button type="button" disabled={!!clarify} title={t("longThinkingClarifyHint")} onClick={() => { if (send({ type: "abort" })) setClarify(state.conversationId); }}>{t("longThinkingClarify")}</button><button type="button" onClick={() => setDismissed(since)}>{t("continueWaiting")}</button></span></div>;
}
