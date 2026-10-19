import type { CSSProperties, ReactNode } from "react";
import { FiBookOpen, FiMessageSquare, FiX } from "react-icons/fi";
import { desktopAPI } from "../desktop";
import { useT } from "../i18n";
import { DesktopWindowControls } from "./DesktopWindowControls";
import { WikiResizeHandle } from "./WikiResizeHandle";

export function WikiWindowShell({ documentPath, loading = false, chatOpen, chatWidth, onChatOpen, onChatResize, onClose, chatHost, children }: {
	documentPath: string;
	loading?: boolean;
	chatOpen: boolean;
	chatWidth: number;
	onChatOpen: (open: boolean) => void;
	onChatResize: (width: number) => void;
	onClose: () => void;
	chatHost: (node: HTMLDivElement | null) => void;
	children: ReactNode;
}) {
	const t = useT();
	const documentName = documentPath.split("/").at(-1) || t("wikiMode");
	return <div className="wiki-window-shell">
		<header className="wiki-window-header wiki-view-header">
			<span className="wiki-window-mark" aria-hidden="true"><FiBookOpen /></span>
			<div id="wiki-modal-toolbar">{loading && <span className="wiki-breadcrumb">{documentName}</span>}</div>
			<button className="wiki-agent-toggle" aria-label={t("wikiAskPi")} title={t("wikiAskPi")} aria-expanded={chatOpen} disabled={loading} onClick={() => onChatOpen(!chatOpen)}><FiMessageSquare /><span>{t("wikiAskPi")}</span></button>
			{!desktopAPI && <button className="wiki-window-close" aria-label={t("wikiExitMode")} title={t("wikiExitMode")} onClick={onClose}><FiX /></button>}
			<DesktopWindowControls />
		</header>
		<div className="wiki-modal-body wiki-window-body" style={{ "--wiki-chat-width": `${chatWidth}px` } as CSSProperties}>
			{children}
			{chatOpen && <button className="wiki-agent-scrim" aria-label={t("wikiCloseChat")} onClick={() => onChatOpen(false)} />}
			<aside className="wiki-agent-chat design-workspace" hidden={!chatOpen} aria-label={t("wikiAskPi")}>
				<WikiResizeHandle side="chat" width={chatWidth} onResize={onChatResize} />
				<header className="wiki-agent-header">
					<div className="wiki-agent-heading"><strong>{t("wikiAskPi")}<span title={documentPath}>{documentName}</span></strong><small>{t("wikiEphemeralChat")}</small></div>
					<button aria-label={t("wikiCloseChat")} title={t("wikiCloseChat")} onClick={() => onChatOpen(false)}><FiX /></button>
				</header>
				<div className="wiki-agent-host" ref={chatHost} />
			</aside>
		</div>
	</div>;
}
