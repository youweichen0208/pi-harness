import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { usePlaygroundHost } from "../playground-context";
import { editPlaygroundQuestion, openPlaygroundChat, playgroundChatRequest, sendPlaygroundQuestion, usePlaygroundChat } from "../playground-chat-store";
import type { PlaygroundChatContext, UiMessage } from "../types";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { CopyButton } from "./copy-button";

function ChatMessage({ message }: { message: UiMessage }) {
	let content = message.content;
	if (message.role === "user") content = content.map(block => {
		if (block.type !== "text") return block;
		try { const parsed = JSON.parse(String(block.text)); return { type: "text" as const, text: parsed.question ?? block.text }; } catch { return block; }
	});
	return <article className={`pg-chat-message ${message.role}`}>{content.map((block, i) => block.type === "thinking" ? <ThinkingBlock key={i} thinking={String(block.thinking)} /> : block.type === "text" ? <Markdown key={i} text={String(block.text)} /> : null)}{message.errorMessage && <p role="alert">{message.errorMessage}</p>}</article>;
}
export function PlaygroundChat({ context, apply }: { context: PlaygroundChatContext; apply: (base: string, code: string) => boolean }) {
	const t = useT();
	const host = usePlaygroundHost();
	const { state, draft, pending, error, connected } = usePlaygroundChat();
	const [dismissed, setDismissed] = useState<string[]>([]);
	const [applyError, setApplyError] = useState(false);
	useEffect(() => { openPlaygroundChat(host.model, host.thinking); }, []);
	const locked = !connected || !!pending || !!state?.running;
	return <section className="pg-chat">
		<div className="pg-chat-controls">
			<button className="btn" disabled={locked} onClick={() => playgroundChatRequest("new")}>{t("pgChatNew")}</button>
			<select aria-label={t("pgChatHistory")} value={state?.id ?? ""} disabled={locked} onChange={e => playgroundChatRequest("switch", { targetId: e.target.value })}>{state?.history.map(h => <option key={h.id} value={h.id}>{h.title}</option>)}</select>
		</div>
		<div className="pg-chat-messages" aria-live="polite">
			{state?.interrupted && <p role="status">{t("pgChatInterrupted")}</p>}
			{state?.messages.filter(m => m.role === "user" || m.role === "assistant").map((m, i) => <ChatMessage key={i} message={m} />)}
			{state?.streaming && <ChatMessage message={state.streaming} />}
			{state?.proposals.filter(p => !dismissed.includes(p.id)).map(p => <article className="pg-chat-proposal" key={p.id}>
				<Markdown text={p.explanation} />
				<details><summary>{t("pgChatDiff")}</summary><div className="change-lines">
					{p.base.split("\n").map((line, i) => <div className="change-line del" key={`old${i}`}><span className="change-marker">−</span><code>{line}</code></div>)}
					{p.code.split("\n").map((line, i) => <div className="change-line add" key={`new${i}`}><span className="change-marker">+</span><code>{line}</code></div>)}
				</div></details>
				<CopyButton text={p.code} />
				{context.code !== p.base && <p>{t("pgChatStaleProposal")}</p>}
				<button className="btn primary" disabled={context.code !== p.base} onClick={() => {
					if (apply(p.base, p.code)) setDismissed(items => [...items, p.id]); else setApplyError(true);
				}}>{t("pgChatApply")}</button>
				<button className="btn" onClick={() => setDismissed(items => [...items, p.id])}>{t("pgChatIgnore")}</button>
			</article>)}
		</div>
		{(error || state?.error || applyError) && <p role="alert">{applyError ? t("pgChatStaleProposal") : error === "pgChatUnconfirmed" ? t("pgChatUnconfirmed") : error || state?.error}</p>}
		<div className="pg-chat-references">
			<details><summary>{t("pgChatCode")}</summary><pre>{context.code}</pre></details>
			<details><summary>{t("pgTestCases")}</summary><pre>{context.parameters}</pre></details>
			<details><summary>{t("pgChatOutput")}{context.partial ? ` · ${t("pgChatPartial")}` : ""}{context.stale ? ` · ${t("pgChatStale")}` : ""}{context.truncated ? ` · ${t("pgChatTruncated")}` : ""}</summary><p>{context.runVersion}</p><pre>{context.output}</pre></details>
		</div>
		<textarea id="pg-chat-input" aria-label={t("pgChatAsk")} placeholder={t("pgChatPlaceholder")} value={draft} onChange={e => editPlaygroundQuestion(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendPlaygroundQuestion(context); } }} />
		<div className="pg-chat-controls">
			<select aria-label={t("pgChatModel")} value={state?.model ? JSON.stringify([state.model.provider, state.model.id]) : ""} disabled={locked} onChange={e => { const [provider, id] = JSON.parse(e.target.value); playgroundChatRequest("model", { model: { provider, id } }); }}>
				<option value="" disabled>{t("pgChatModel")}</option>{state?.models.map(m => <option key={JSON.stringify([m.provider, m.id])} value={JSON.stringify([m.provider, m.id])}>{m.name}</option>)}
			</select>
			<select aria-label={t("pgChatThinking")} value={state?.thinking ?? "off"} disabled={locked} onChange={e => playgroundChatRequest("thinking", { thinking: e.target.value })}>{["off", "minimal", "low", "medium", "high", "xhigh"].map(level => <option key={level} value={level}>{t(({ off: "pgThinkOff", minimal: "pgThinkMinimal", low: "pgThinkLow", medium: "pgThinkMedium", high: "pgThinkHigh", xhigh: "pgThinkXhigh" } as const)[level as "off"])}</option>)}</select>
			{state?.running ? <button className="btn" disabled={!connected} onClick={() => playgroundChatRequest("stop")}>{t("playgroundStop")}</button> : <button className="btn primary" disabled={locked || !state || !draft.trim()} onClick={() => sendPlaygroundQuestion(context)}>{t("pgChatSend")}</button>}
		</div>
	</section>;
}
