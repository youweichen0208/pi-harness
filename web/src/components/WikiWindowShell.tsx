import { WikiReadingOutline } from "../wiki-reading-outline";
import { WelcomeMotto } from "./WelcomeMotto";
import { WikiProjectPicker } from "./WikiProjectPicker";
import type { WikiProjectReference } from "../types";
import { WikiAssistantWindow } from "./WikiAssistantWindow";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FiBookOpen, FiMessageSquare, FiX, FiPlus, FiClock, FiChevronDown, FiMinimize2 } from "react-icons/fi";
import { LuTableOfContents, LuPin, LuPinOff } from "react-icons/lu";
import { WikiOutline } from "./WikiOutline";
import { WikiAssistantSheet } from "./WikiAssistantSheet";
import { desktopAPI } from "../desktop";
import { useT } from "../i18n";
import { DesktopWindowControls } from "./DesktopWindowControls";
import { WikiResizeHandle } from "./WikiResizeHandle";

type Geometry = { x: number; y: number; width: number; height: number };
export function WikiWindowShell({ documentPath, loading = false, chatOpen, chatWidth, onChatOpen, onChatResize, onClose, chatHost, notices, children, cwd, conversationId, references = [], onReferences, onChatAction, empty, modelControls, currentIncluded = true, project, onProject }: {
	project?: WikiProjectReference | null; onProject?: (project: WikiProjectReference | null) => void;
	documentPath: string; loading?: boolean; chatOpen: boolean; chatWidth: number;
	onChatOpen: (open: boolean) => void; onChatResize: (width: number) => void; onClose: () => void;
	chatHost: (node: HTMLDivElement | null) => void; notices?: ReactNode; children: ReactNode;
	cwd?: string; conversationId?: string; references?: string[]; onReferences?: (paths: string[]) => Promise<void>;
	onChatAction?: (action: string, id?: string) => void; currentIncluded?: boolean; empty?: boolean; modelControls?: ReactNode;
}) {
	const t = useT();
	const scope = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null);
	const [mobileOutlineOpen, setMobileOutlineOpen] = useState(false);
	const [sheet, setSheet] = useState<"projects" | "history" | null>(null);
	const [docked, setDocked] = useState(() => { try { return localStorage.getItem("pi-wiki-assistant-docked") === "true"; } catch { return false; } });
	const [geometry, setGeometry] = useState<Geometry | null>(null);
	const [narrow, setNarrow] = useState(() => window.innerWidth < 900);
	const drag = useRef<{ x: number; y: number; geometry: Geometry; resize: boolean } | null>(null);
	const clamp = (value: Geometry): Geometry => {
		const bounds = body.current?.getBoundingClientRect();
		const w = bounds?.width ?? window.innerWidth, h = bounds?.height ?? window.innerHeight;
		const width = Math.max(0, Math.min(Math.max(340, value.width), w - 24));
		const height = Math.max(0, Math.min(Math.max(360, value.height), h - 24));
		return { width, height, x: Math.max(12, Math.min(value.x, w - width - 12)), y: Math.max(12, Math.min(value.y, h - height - 12)) };
	};
	useLayoutEffect(() => {
		const update = () => {
			setNarrow(window.innerWidth < 900);
			if (window.innerWidth < 900) return;
			setGeometry(previous => {
				if (previous) return clamp(previous);
				try { const saved = JSON.parse(localStorage.getItem("pi-wiki-assistant-geometry") ?? "null"); if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return clamp(saved); } catch { /* Optional layout. */ }
				return clamp({ x: (body.current?.clientWidth ?? window.innerWidth) - 391, y: 16, width: 375, height: 820 });
			});
		};
		update(); const observer = new ResizeObserver(update); if (body.current) observer.observe(body.current);
		window.addEventListener("resize", update);
		return () => { observer.disconnect(); window.removeEventListener("resize", update); };
	}, []);
	useEffect(() => { if (!chatOpen) setSheet(null); }, [chatOpen]);
	const closeChat = () => { onChatOpen(false); setSheet(null); scope.current?.querySelector<HTMLButtonElement>(".wiki-ask-toggle")?.focus(); };
	const move = (event: React.PointerEvent<HTMLElement>) => {
		if (!drag.current) return;
		const old = drag.current, dx = event.clientX - old.x, dy = event.clientY - old.y;
		setGeometry(clamp(old.resize ? { ...old.geometry, width: old.geometry.width + dx, height: old.geometry.height + dy } : { ...old.geometry, x: old.geometry.x + dx, y: old.geometry.y + dy }));
	};
	const finish = () => { drag.current = null; if (geometry) try { localStorage.setItem("pi-wiki-assistant-geometry", JSON.stringify(geometry)); } catch { /* Optional layout. */ } };
	const start = (event: React.PointerEvent<HTMLElement>, resize = false) => {
		if (detached || docked || narrow || !geometry || event.button !== 0 || (!resize && (event.target as HTMLElement).closest("button"))) return;
		event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { x: event.clientX, y: event.clientY, geometry, resize };
	};
	useEffect(() => { setSheet(null); }, [documentPath, conversationId]);
	const documentName = documentPath.split("/").at(-1) || t("wikiChooseDocuments");
	const detached = !!desktopAPI && !docked && chatOpen;
	const float = !docked && (!narrow || !!desktopAPI);
	const outline = <aside className={`wiki-agent-chat wiki-outline-aside ${!mobileOutlineOpen ? "wiki-outline-resting" : ""}`} hidden={chatOpen && (docked || narrow)} aria-label={t("richToc")}>
				<header className="wiki-agent-header"><strong>{t("richToc")}</strong><button className="wiki-outline-close" aria-label={t("close")} onClick={() => setMobileOutlineOpen(false)}><FiX /></button></header>
				<div id="wiki-panel-outline" className="wiki-outline-panel"><WikiOutline key={documentPath} scope={scope} onNavigate={() => setMobileOutlineOpen(false)} /></div>
			</aside>;
	return <div className="wiki-window-shell" ref={scope}>
		<header className="wiki-window-header wiki-view-header">
			<span className="wiki-window-mark" aria-hidden="true"><FiBookOpen /></span>
			<div id="wiki-modal-toolbar">{loading && <span className="wiki-breadcrumb">{documentName}</span>}</div>
			<button className="wiki-agent-toggle" aria-label={t("richToc")} title={t("richToc")} aria-pressed={!(chatOpen && docked)} disabled={loading} onClick={() => { if (docked || narrow) onChatOpen(false); setMobileOutlineOpen(open => !open); }}><LuTableOfContents /></button>
			<button className="wiki-agent-toggle wiki-ask-toggle" aria-label={t("wikiAskPi")} title={t("wikiAskPi")} aria-expanded={chatOpen} disabled={loading} onClick={() => { onChatOpen(!chatOpen); setMobileOutlineOpen(false); }}><FiMessageSquare /><span>{t("wikiAskPi")}</span></button>
			{!desktopAPI && <button className="wiki-window-close" aria-label={t("wikiExitMode")} title={t("wikiExitMode")} onClick={onClose}><FiX /></button>}
			<DesktopWindowControls />
		</header>
		<div ref={body} className="wiki-modal-body wiki-window-body" style={{ "--wiki-chat-width": `${chatWidth}px` } as CSSProperties}>
			<WikiReadingOutline.Provider value={narrow || (chatOpen && docked) ? null : outline}>{children}</WikiReadingOutline.Provider>
			{mobileOutlineOpen && <button className="wiki-agent-scrim" aria-label={t("close")} onClick={() => setMobileOutlineOpen(false)} />}
			{narrow && outline}

			<WikiAssistantWindow detached={detached} onClose={closeChat}><aside ref={panel} className={`wiki-agent-chat wiki-assistant ${float ? "is-floating" : "is-docked"} ${empty ? "is-empty" : ""}`} hidden={!chatOpen} aria-label={t("wikiAskPi")} onKeyDown={event => {
				if (event.key === "Escape" && !event.defaultPrevented && !sheet && !panel.current?.querySelector('[role="listbox"], [role="menu"], .dropdown-menu')) { event.stopPropagation(); closeChat(); }
			}} style={float && geometry ? { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height } : undefined}>
				{docked && <WikiResizeHandle side="chat" width={chatWidth} onResize={onChatResize} />}
				<header className="wiki-assistant-header" onPointerDown={event => start(event)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
					<img className="wiki-assistant-mark" src="/icon/1a-mark.svg" alt="" draggable={false} /><strong>{t("wikiAskPi")}</strong>
					<button disabled={narrow && !desktopAPI} title={t(docked ? "wikiFloatPanel" : "wikiDockPanel")} aria-label={t(docked ? "wikiFloatPanel" : "wikiDockPanel")} aria-pressed={docked} onClick={() => { setDocked(!docked); try { localStorage.setItem("pi-wiki-assistant-docked", String(!docked)); } catch { /* Optional layout. */ } }}>{docked ? <LuPinOff /> : <LuPin />}</button>
					<button title={t("wikiNewChat")} aria-label={t("wikiNewChat")} onClick={() => onChatAction?.("chat-new")}><FiPlus /></button>
					<button title={t("wikiChatHistory")} aria-label={t("wikiChatHistory")} onClick={() => setSheet("history")}><FiClock /></button>
					<button title={t("wikiCloseChat")} aria-label={t("wikiCloseChat")} onClick={closeChat}><FiMinimize2 /></button>
				</header>
				{!empty && <button className="wiki-assistant-context" title={documentPath} onClick={() => setSheet("projects")}><FiBookOpen /><span>{documentName}{project ? ` + ${project.name}` : ""}</span><FiChevronDown /></button>}
				{empty && <div className="wiki-assistant-welcome wiki-analysis-welcome">
					<div className="wiki-analysis-mode"><div className="wiki-assistant-model">{modelControls}</div><button className="wiki-analysis-scope" onClick={() => setSheet("projects")}><FiBookOpen /><span>{t(project ? "wikiWithProject" : "wikiDocumentOnly")}</span><FiChevronDown /></button></div>
					<WelcomeMotto plain />
				</div>}

				<div id="wiki-panel-chat" className="wiki-agent-host" ref={chatHost} />
				{float && <button className="wiki-assistant-resize" aria-label={t("dragToResize")} onPointerDown={event => start(event, true)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onKeyDown={event => { if (!geometry || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); setGeometry(clamp({ ...geometry, width: geometry.width + (event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0), height: geometry.height + (event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0) })); }}>⌟</button>}
				{sheet === "projects" && cwd && conversationId && onProject && <WikiProjectPicker key={`${cwd}:${conversationId}`} cwd={cwd} conversationId={conversationId} onSelect={onProject} onClose={() => setSheet(null)} />}
				{sheet === "history" && cwd && conversationId && onReferences && onChatAction && <WikiAssistantSheet key={`${cwd}:${conversationId}:${sheet}`} kind={sheet} cwd={cwd} conversationId={conversationId} documentPath={documentPath} currentIncluded={currentIncluded} references={references} onReferences={onReferences} onChatAction={onChatAction} onClose={() => setSheet(null)} />}
			</aside></WikiAssistantWindow>
		</div>
		<footer className="wiki-statusbar"><div id="wiki-window-index" />{notices}</footer>
	</div>;
}
