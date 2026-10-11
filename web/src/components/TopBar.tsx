import { useChanges } from "../changes-context";
import { ChangeCounts } from "./ChangeSummaryCard";
import { toolTextIncidents } from "../tool-text";
import { openSessionTree } from "../tree-events";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { LuPanelLeft as FiSidebar, LuDatabase as FiDatabase, LuGitBranch as FiGitBranch, LuGlobe as FiGlobe, LuMenu as FiMenu, LuMessageSquare as FiMessageSquare, LuSearch as FiSearch, LuPlus as FiPlus, LuSettings as FiSettings, LuTarget as FiTarget, LuLayers as FiLayers, LuTerminal as FiTerminal, LuMinus as FiMinus, LuSquare as FiSquare, LuCopy as FiCopy, LuX as FiX } from "react-icons/lu";
import { desktopAPI, type DesktopWindowState } from "../desktop";
import type { ChatState } from "../use-chat";
import type { ClientMessage, CommandDef } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";
import { SoundSettingsPanel } from "./SoundSettings";
import type { SoundKind, SoundSettings } from "../sounds";
import { useI18n, type Locale } from "../i18n";
import { skillAwarePreview } from "../skill-block";
import { conversationDisplayTitle } from "../conversation-display-title";

interface TopBarProps {
	onOpenDatabase: () => void;
	leftCollapsed?: boolean;
	gitChangeCount: number;
	onOpenTask: () => void;
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	/** Minimal terminal-tab bridge (same shape SCMPanel uses) — updates run there. */
	terminal: {
		create: (meta: {
			id: string;
			conversationId: string;
			title: string;
			cwd: string;
			cols: number;
			rows: number;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}) => void;
		restart: (id: string) => void;
	};
	view: "chat" | "terminal" | "git" | "nodes" | `plugin:${string}`;
	onViewChange: (view: "chat" | "terminal" | "git" | "nodes" | `plugin:${string}`) => void;
	/** Installed optional plugins (<dataDir>/plugins) — one view tab each. */
	plugins: { id: string; name: string; icon?: string; description?: string; error?: string }[];
	/** Open a side panel as a mobile drawer ("left" = history, "right" = files). */
	onOpenPanel: (side: "left" | "right") => void;
	/** Open the custom model config panel. */
	onManageModels: () => void;
	/** Open the settings panel (system prompt / skills / extensions / presets). */
	onOpenSettings: () => void;
	/** Open the background-task panel (AI-started servers — stop individually or all). */
	onOpenBgTasks: () => void;
	/** Open the global search panel (sessions / projects / workspace files). */
	onOpenGlobalSearch: () => void;
	/** Sound notification settings + change handler (owned by App). */
	sound: SoundSettings;
	onSoundChange: (settings: SoundSettings) => void;
	onSoundPreview: (kind: SoundKind) => void;
}

export function TopBar({
	onOpenDatabase,
	leftCollapsed = false,
	gitChangeCount,
	onOpenTask,
	chat,
	send,
	terminal,
	view,
	plugins,
	onViewChange,
	onOpenPanel,
	onManageModels,
	onOpenSettings,
	onOpenBgTasks,
	onOpenGlobalSearch,
	sound,
	onSoundChange,
	onSoundPreview,
}: TopBarProps) {
	const { locale, setLocale, t } = useI18n();
	const changes = useChanges();
	const [moreOpen, setMoreOpen] = useState(false);
	const [viewsOpen, setViewsOpen] = useState(false);
	const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
	useEffect(() => {
		setMenuHost(!leftCollapsed ? document.getElementById("sidebar-settings-slot") : null);
		if (view === "nodes") setMoreOpen(false);
	}, [view, leftCollapsed]);
	const [windowState, setWindowState] = useState<DesktopWindowState>({ maximized: false, fullscreen: false });
	useEffect(() => desktopAPI?.onWindowState(setWindowState), []);
	const projectName = chat.state?.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
	const notGitRepo = chat.gitBranch?.cwd === chat.state?.cwd && !!chat.gitBranch?.notRepo;
	const incident = chat.state?.conversationId === chat.activeConversationId ? toolTextIncidents(chat.state.streamingMessage ? [...chat.state.messages, chat.state.streamingMessage] : chat.state.messages, chat.state.isStreaming).current : undefined;
	const interrupted = incident?.state === "stopped";
	const reminding = incident?.state === "reminding";
	const task = chat.state?.conversationId === chat.activeConversationId ? chat.state?.taskProgress : null;
	const planItems = (task?.status === "running" || task?.status === "waiting") ? task.plan?.items.filter((item) => item.status !== "removed") ?? [] : [];
	const currentStep = planItems.findIndex((item) => item.status === "running");

	const session = chat.sessions.find((item) => item.path === chat.state?.sessionFile);
	const conversation = chat.conversations.find((item) => item.id === chat.activeConversationId);
	const conversationTitle = conversationDisplayTitle(
		conversation?.title || skillAwarePreview(session?.firstMessage ?? "") || t("newChat"),
		session?.firstMessage,
		session?.name,
		Math.max(session?.messageCount ?? 0, conversation?.messageCount ?? 0, chat.state?.messages.length ?? 0),
		locale,
		chat.state?.messages,
	);

	const LANGUAGES: { value: Locale; label: string }[] = [
		{ value: "zh", label: t("langZh") },
		{ value: "en", label: t("langEn") },
	];

	const settingsMenu = (
				<div className="topbar-more">
					<Dropdown
						trigger={
							<>
								<FiSettings aria-hidden="true" />
								<span className="chip-sub">{t("settings")}</span>
							</>
						}
						open={moreOpen}
						onOpenChange={setMoreOpen}
						menuClassName="workspace-settings-menu"
					>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenSettings();
							}}
						>
							<FiSettings aria-hidden="true" /><span className="workspace-menu-label">{t("allSettings")}</span>
						</DropdownItem>
						<div className="dd-header workspace-menu-section">{t("quickActions")}</div>
						<DropdownItem onClick={() => { setMoreOpen(false); openSessionTree(); }}><FiGitBranch aria-hidden="true" /><span className="workspace-menu-label">{t("treeTitle")}</span></DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenGlobalSearch();
							}}
						>
							<FiSearch aria-hidden="true" /><span className="workspace-menu-label">{t("searchGlobal")}</span>
						</DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenBgTasks();
							}}
						>
							<FiLayers aria-hidden="true" /><span className="workspace-menu-label">{t("bgTasks")}</span>
							{chat.bgServers.length > 0 && (
								<em className="bg-task-badge">{chat.bgServers.length}</em>
							)}
						</DropdownItem>
						<SoundSettingsPanel
							settings={sound}
							onChange={onSoundChange}
							onPreview={onSoundPreview}
						/>
						<div className="dd-header">{t("language")}</div>
						{LANGUAGES.map((l) => (
							<DropdownItem
								key={l.value}
								active={locale === l.value}
								onClick={() => setLocale(l.value)}
							>
								{l.label}
							</DropdownItem>
						))}
					</Dropdown>
				</div>
	);
	return (
		<header className="topbar">
			<div className="brand">
				<button
					type="button"
					className="panel-toggle"
					title={t("openHistory")}
					onClick={() => onOpenPanel("left")}
				>
					<FiMenu />
				</button>
				<img className="brand-logo" src="/icon/1a-mark.svg" alt="" />
				<span className="brand-name">pi-harness</span>
				{desktopAPI && (
					<span className="desktop-window-title" title={chat.state?.cwd ?? ""}>
						pi-harness <span className="desktop-title-separator">/</span> {projectName || t("desktopWorkspace")}
					</span>
				)}
			</div>

			{view !== "nodes" && <button type="button" className="project-panel-toggle" title={t(leftCollapsed ? "expandProjects" : "collapseProjects")} aria-label={t(leftCollapsed ? "expandProjects" : "collapseProjects")} aria-expanded={!leftCollapsed} onClick={() => onOpenPanel("left")}><FiSidebar /></button>}
			<div className="header-location"><span title={chat.state?.cwd}>{projectName || t("desktopWorkspace")}</span><i>/</i><button className="conversation-title-button" title={t("treeTitle")} onClick={() => openSessionTree()}><strong title={conversationTitle}>{conversationTitle}</strong><span aria-hidden="true">⌄</span></button>{view === "chat" && chat.gitBranch?.branch && <code className="changes-current-branch">{chat.gitBranch.branch}</code>}{(interrupted || reminding || currentStep >= 0 || !!task?.plan?.awaitingConfirmation) && <button type="button" className={`header-task-progress${interrupted ? " interrupted" : reminding ? " reminding" : ""}`} title={t("taskProgress")} onClick={onOpenTask}><span aria-hidden="true">●</span>{interrupted ? t("toolRecoveryInterrupted") : reminding ? t("working") : task?.plan?.awaitingConfirmation ? t("taskProgress") : t("taskPlanPosition", { current: currentStep + 1, total: planItems.length })}</button>}</div>
			<div className="topbar-actions">
				<div
					className="view-switch"
					role="tablist"
					aria-label={t("viewSwitch")}
				>
					<button
						type="button"
						role="tab"
						aria-label={t("chat")}
						title={t("chat")}
						aria-selected={view === "chat"}
						className={view === "chat" ? "active" : ""}
						onClick={() => onViewChange("chat")}
					>
						<FiMessageSquare />
						<span>{t("chat")}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-label={t("terminal")}
						title={t("terminal")}
						aria-selected={view === "terminal"}
						className={view === "terminal" ? "active" : ""}
						onClick={() => onViewChange("terminal")}
					>
						<FiTerminal />
						<span>{t("terminal")}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-label={t("scmTab")}
						title={notGitRepo ? t("notGitRepoShort") : t("scmTab")}
						aria-disabled={notGitRepo}
						className={view === "git" ? "active" : undefined}
						aria-selected={view === "git"}
						onClick={() => { if (!notGitRepo) onViewChange("git"); }}
					>
						<FiGitBranch />
						<span>{t("scmTab")}</span>
						{!notGitRepo && gitChangeCount > 0 && <em className="tab-change-count">{gitChangeCount}</em>}
					</button>

				</div>

				<div className="workspace-more">
					<Dropdown trigger={<span>{t("more")}</span>} open={viewsOpen} onOpenChange={setViewsOpen} menuClassName="workspace-view-menu">
						<DropdownItem onClick={() => { setViewsOpen(false); send({ type: "new_chat" }); }}><FiPlus />{t("newChat")}</DropdownItem>
						<DropdownItem onClick={() => { setViewsOpen(false); onOpenDatabase(); }}><FiDatabase />{t("dbTitle")}</DropdownItem>
						<DropdownItem active={view === "nodes"} onClick={() => { setViewsOpen(false); onViewChange("nodes"); }}><FiGlobe />{t("nodes")}</DropdownItem>
						<DropdownItem onClick={() => { setViewsOpen(false); onOpenBgTasks(); }}><FiLayers />{t("bgTasks")}{chat.bgServers.length > 0 && <em className="bg-task-badge">{chat.bgServers.length}</em>}</DropdownItem>
						{view === "chat" && changes && <DropdownItem active={changes.open} onClick={() => { setViewsOpen(false); changes.set({ open: !changes.open }); }}><FiLayers />{t("changesTitle")}<ChangeCounts files={changes.files} /></DropdownItem>}
						{plugins.map(p => <DropdownItem key={p.id} active={view === `plugin:${p.id}`} title={p.error || p.description || p.name} onClick={() => { setViewsOpen(false); onViewChange(`plugin:${p.id}`); }}>{p.name}</DropdownItem>)}
					</Dropdown>
				</div>

				{/* Mobile "⋯" panel — folds sound / language. */}
				{view !== "nodes" && (menuHost ? createPortal(settingsMenu, menuHost) : settingsMenu)}

				<button
					type="button"
					className="panel-toggle"
					title={t("openFiles")}
					onClick={() => onOpenPanel("right")}
				>
					<FiSidebar />
				</button>
			</div>
			{desktopAPI && desktopAPI.platform !== "darwin" && (
				<div className="desktop-window-controls" aria-label={t("windowControls")}>
					<button type="button" title={t("minimizeWindow")} aria-label={t("minimizeWindow")} onClick={() => desktopAPI?.windowAction("minimize")}><FiMinus /></button>
					<button type="button" title={windowState.maximized || windowState.fullscreen ? t("restoreWindow") : t("maximizeWindow")} aria-label={windowState.maximized || windowState.fullscreen ? t("restoreWindow") : t("maximizeWindow")} onClick={() => desktopAPI?.windowAction("toggle-maximize")}>{windowState.maximized || windowState.fullscreen ? <FiCopy /> : <FiSquare />}</button>
					<button type="button" className="desktop-window-close" title={t("closeWindow")} aria-label={t("closeWindow")} onClick={() => desktopAPI?.windowAction("close")}><FiX /></button>
				</div>
			)}
		</header>
	);
}
