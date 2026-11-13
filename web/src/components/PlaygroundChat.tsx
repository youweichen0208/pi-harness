import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { usePlaygroundHost } from "../playground-context";
import { editPlaygroundQuestion, openPlaygroundChat, playgroundChatRequest, sendPlaygroundQuestion, usePlaygroundChat } from "../playground-chat-store";
import type { PlaygroundChatContext, UiMessage } from "../types";
import { Markdown } from "./Markdown";
import { Message } from "./Message";
import { Dropdown, DropdownItem } from "./Dropdown";
import { FiArrowUp, FiClock, FiCpu, FiPlus } from "react-icons/fi";
import { WelcomeMotto } from "./WelcomeMotto";
import { CopyButton } from "./copy-button";

const emptyMap = new Map();
function ChatMessage({ message, streaming = false }: { message: UiMessage; streaming?: boolean }) {
	let content = message.content;
	if (message.role === "user") content = content.map(block => {
		if (block.type !== "text") return block;
		try { const parsed = JSON.parse(String(block.text)); return { type: "text" as const, text: parsed.question ?? block.text }; } catch { return block; }
	});
	return <Message message={{ ...message, content: content.filter(b => b.type === "text" || b.type === "thinking") }} toolResults={emptyMap} liveOutputs={emptyMap} toolStatuses={emptyMap} streaming={streaming} isLast={streaming} thinkingWrap={false} />;
}
export function PlaygroundChat({ context, apply }: { context: PlaygroundChatContext; apply: (base: string, code: string) => boolean }) {
	const t = useT();
	const host = usePlaygroundHost();
	const { state, draft, pending, error, connected } = usePlaygroundChat();
	const [dismissed, setDismissed] = useState<string[]>([]);
	const [modelOpen, setModelOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const input = useRef<HTMLTextAreaElement>(null);
	const messages = useRef<HTMLDivElement>(null);
	const followOutput = useRef(true);
	useLayoutEffect(() => { followOutput.current = true; }, [state?.id]);
	useLayoutEffect(() => {
		if (followOutput.current && messages.current) messages.current.scrollTop = messages.current.scrollHeight;
	}, [state?.messages, state?.streaming]);
	useLayoutEffect(() => { if (input.current) { input.current.style.height = "auto"; input.current.style.height = Math.min(input.current.scrollHeight, 120) + "px"; } }, [draft]);
	const [applyError, setApplyError] = useState(false);
	useEffect(() => { openPlaygroundChat(host.model, host.thinking); }, []);
	const modelReady = !!state?.model && state.models.some(m => m.provider === state.model!.provider && m.id === state.model!.id);
	const locked = !connected || !!pending || !!state?.running;
	const empty = !state?.messages.some(m => m.role === "user" || m.role === "assistant") && !state?.streaming;
	const modelSelect = <Dropdown keyboardNavigation align="left" direction="up" trigger={<><FiCpu aria-hidden="true" /><span className="chip-model" title={state?.model?.name}>{state?.model?.name ?? t("pgChatModel")}</span></>} open={modelOpen} onOpenChange={open => { if (!locked) setModelOpen(open); }}>
		<div className="dd-header">{t("pgChatModel")}</div>
		{state?.models.map(m => <DropdownItem disabled={locked} key={JSON.stringify([m.provider, m.id])} active={m.provider === state.model?.provider && m.id === state.model?.id} onClick={() => { playgroundChatRequest("model", { model: { provider: m.provider, id: m.id } }); setModelOpen(false); }}>{m.name}</DropdownItem>)}
	</Dropdown>;
	return <section className="pg-chat wiki-assistant">
		<header className="wiki-assistant-header">
			<img className="wiki-assistant-mark" src="/icon/1a-mark.svg" alt="" /><strong>{t("pgChatAsk")}</strong>
			<button className="pg-chat-icon" title={t("pgChatNew")} aria-label={t("pgChatNew")} disabled={locked} onClick={() => playgroundChatRequest("new")}><FiPlus /></button>
			<button className="pg-chat-icon" title={t("pgChatHistory")} aria-label={t("pgChatHistory")} aria-expanded={historyOpen} aria-controls="pg-chat-history" onClick={() => setHistoryOpen(!historyOpen)}><FiClock /></button>
		</header>
		{historyOpen && <div id="pg-chat-history" className="pg-chat-history">
			<label>{t("pgChatHistory")}<select autoFocus value={state?.id ?? ""} disabled={locked} onKeyDown={e => { if (e.key === "Escape") { setHistoryOpen(false); } }} onChange={e => { playgroundChatRequest("switch", { targetId: e.target.value }); setHistoryOpen(false); }}>{state?.history.map(h => <option key={h.id} value={h.id}>{h.title}</option>)}</select></label>
		</div>}
		<div ref={messages} onScroll={e => { const el = e.currentTarget; followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }} className={`messages pg-chat-messages ${empty ? "is-empty" : ""}`} aria-live="polite">
			{empty && <div className="pg-chat-welcome"><WelcomeMotto plain /></div>}
			{state?.interrupted && <p role="status">{t("pgChatInterrupted")}</p>}
			{state?.messages.filter(m => m.role === "user" || m.role === "assistant").map((m, i) => <ChatMessage key={i} message={m} />)}
			{state?.streaming && <ChatMessage message={state.streaming} streaming />}
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
		{(error || state?.error || applyError) && <p role="alert">{applyError ? t("pgChatStaleProposal") : error === "pgChatUnconfirmed" ? t("pgChatUnconfirmed") : error === "Error: pgChatModelUnavailable" ? t("pgChatModelUnavailable") : error || state?.error}</p>}
		{state && !modelReady && <p role="status">{t("pgChatModelUnavailable")}</p>}
		<div className="inputbar pg-chat-inputbar"><div className={`inputbox ${draft ? "has-draft" : ""}`}>
		<div className="pg-chat-references">
			<details><summary>@{t("pgChatCode")}</summary><pre>{context.code}</pre></details>
			<details><summary>{t("pgTestCases")}</summary><pre>{context.parameters}</pre></details>
			<details><summary>{t("pgChatOutput")}{context.partial ? ` · ${t("pgChatPartial")}` : ""}{context.stale ? ` · ${t("pgChatStale")}` : ""}{context.truncated ? ` · ${t("pgChatTruncated")}` : ""}</summary><p>{context.runVersion}</p><pre>{context.output}</pre></details>
		</div>
		<div className="inputbox-row"><textarea ref={input} rows={1} id="pg-chat-input" aria-label={t("pgChatAsk")} placeholder={t("pgChatComposerPlaceholder")} value={draft} onChange={e => editPlaygroundQuestion(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendPlaygroundQuestion(context); } }} /></div>
		<div className="input-tools">
			<div className="input-tools-left">
			{modelSelect}
			</div><div className="input-tools-right"><div className="inputbox-actions">
			{state?.running ? <button className="btn composer-action stop" title={t("playgroundStop")} aria-label={t("playgroundStop")} disabled={!connected} onClick={() => playgroundChatRequest("stop")}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3" /></svg></button> : <button className="btn composer-action send" title={t("pgChatSend")} aria-label={t("pgChatSend")} disabled={locked || !modelReady || !draft.trim()} onClick={() => sendPlaygroundQuestion(context)}><FiArrowUp strokeWidth={3} aria-hidden="true" /></button>}
			</div></div>
		</div>
		</div></div>
	</section>;
}
