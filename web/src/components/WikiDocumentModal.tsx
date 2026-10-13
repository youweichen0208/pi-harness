import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FiMaximize2, FiMinimize2, FiMessageSquare, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { WikiResizeHandle, useWikiPanelWidth } from "./WikiResizeHandle";

/** Native modal isolation; the original chat is docked in the right-hand host. */
export function WikiDocumentModal({ children, onClose, chatHost, chatOpen, onChatOpen, title }: {
	title?: string; children: ReactNode; onClose: () => void; chatHost: (host: HTMLDivElement | null) => void;
	chatOpen: boolean; onChatOpen: (open: boolean) => void;
}) {
	const t = useT();
	const dialog = useRef<HTMLDialogElement>(null);
	const [maximized, setMaximized] = useState(false);
	const [chatWidth, resizeChat] = useWikiPanelWidth("chat");
	// Screen fullscreen entered by this modal; a dialog cannot be the fullscreen element, so the page is.
	const ownsFullscreen = useRef(false);
	useEffect(() => {
		const sync = () => {
			if (!ownsFullscreen.current || document.fullscreenElement) return;
			ownsFullscreen.current = false;
			setMaximized(false);
		};
		document.addEventListener("fullscreenchange", sync);
		return () => {
			document.removeEventListener("fullscreenchange", sync);
			if (ownsFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
		};
	}, []);
	async function toggleMaximized() {
		if (maximized) {
			setMaximized(false);
			if (ownsFullscreen.current && document.fullscreenElement) {
				ownsFullscreen.current = false;
				await document.exitFullscreen().catch(() => {});
			}
			return;
		}
		setMaximized(true);
		if (document.fullscreenElement || !document.fullscreenEnabled) return;
		// Denied fullscreen keeps the in-window maximize.
		try { await document.documentElement.requestFullscreen(); ownsFullscreen.current = true; } catch { /* in-window only */ }
	}
	useLayoutEffect(() => {
		const previous = document.activeElement;
		const element = dialog.current!;
		element.showModal();
		// A native listener also sees the stable chat portal moved into this dialog.
		const trap = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || event.defaultPrevented || !element.contains(event.target as Node)) return;
			const scope = document.activeElement?.closest<HTMLElement>('[role="dialog"]') ?? element.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]') ?? element;
			const items = [...scope.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"], [contenteditable="true"]')].filter(item => item.getClientRects().length && !item.closest("[hidden], [inert]") && !item.parentElement?.closest('[contenteditable="true"]') && item.getAttribute("tabindex") !== "-1");
			event.preventDefault();
			const index = items.indexOf(document.activeElement as HTMLElement);
			const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
			items[next]?.focus({ preventScroll: true });
		};
		document.addEventListener("keydown", trap);
		return () => {
			document.removeEventListener("keydown", trap);
			element.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
		};
	}, []);
	return createPortal(<dialog ref={dialog} className={`wiki-document-dialog${maximized ? " maximized" : ""}`} aria-label={title ?? t("wikiMode")} onCancel={event => {
		event.preventDefault();
		if (chatOpen && window.matchMedia("(max-width: 900px)").matches) onChatOpen(false); else onClose();
	}} onClick={event => {
		if (event.target !== event.currentTarget) return;
		const rect = event.currentTarget.getBoundingClientRect();
		if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
	}}>
		<header className="wiki-modal-header">
			<div id="wiki-modal-toolbar">{title && <strong>{title}</strong>}</div>
			<button className="wiki-agent-toggle" aria-label={t("wikiAgentChat")} title={t("wikiAgentChat")} aria-expanded={chatOpen} onClick={() => onChatOpen(!chatOpen)}><FiMessageSquare /></button>
			<button aria-label={t(maximized ? "wikiRestoreSize" : "wikiMaximize")} title={t(maximized ? "wikiRestoreSize" : "wikiMaximize")} onMouseDown={event => event.preventDefault()} onClick={() => void toggleMaximized()}>{maximized ? <FiMinimize2 /> : <FiMaximize2 />}</button>
			<button aria-label={t("close")} onClick={onClose}><FiX /></button>
		</header>
		<div className="wiki-modal-body" style={{ "--wiki-chat-width": `${chatWidth}px` } as CSSProperties}>
			{children}
			{chatOpen && <button className="wiki-agent-scrim" aria-label={t("wikiCloseChat")} onClick={() => onChatOpen(false)} />}
			<aside className="wiki-agent-chat design-workspace" hidden={!chatOpen} aria-label={t("wikiAgentChat")}>
				<WikiResizeHandle side="chat" width={chatWidth} onResize={resizeChat} />
				<header className="wiki-agent-header"><img src="/icon/1a-mark.svg" alt="" /><strong>{t("wikiAgentChat")}</strong><span>{t("wikiOriginalChat")}</span><button aria-label={t("wikiCloseChat")} onClick={() => onChatOpen(false)}><FiX /></button></header>
				<div className="wiki-agent-host" ref={chatHost} />
			</aside>
		</div>
	</dialog>, document.body);
}
