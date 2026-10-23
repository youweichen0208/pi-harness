import { toolTextIncidents } from "../tool-text";
import { openSessionTree } from "../tree-events";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import {
	FiSidebar,
	FiDatabase,
	FiGitBranch,
	FiGlobe,
	FiMenu,
	FiShare2,
	FiMessageSquare,
	FiSearch,
	FiPlus,
	FiSettings,
	FiTerminal,
} from "react-icons/fi";
import { desktopAPI } from "../desktop";
import type { ChatState } from "../use-chat";
import type { ClientMessage, CommandDef } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";
import { ModelThinking } from "./ModelThinking";
import { SoundSettingsPanel } from "./SoundSettings";
import { DesktopWindowControls } from "./DesktopWindowControls";
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
	view: "chat" | "wiki" | "terminal" | "git" | "nodes" | `plugin:${string}`;
	onViewChange: (view: "chat" | "wiki" | "terminal" | "git" | "nodes" | `plugin:${string}`) => void;
	/** Installed optional plugins (<dataDir>/plugins) — one view tab each. */
	plugins: { id: string; name: string; icon?: string; description?: string; error?: string }[];
	/** Open a side panel as a mobile drawer ("left" = history, "right" = files). */
	onOpenPanel: (side: "left" | "right") => void;
	/** Open the custom model config panel. */
	onManageModels: () => void;
	/** Open the settings panel (system prompt / skills / extensions / presets). */
	onOpenSettings: () => void;
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
	onOpenGlobalSearch,
	sound,
	onSoundChange,
	onSoundPreview,
}: TopBarProps) {
	const { locale, setLocale, t } = useI18n();
	const [langOpen, setLangOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
	useEffect(() => {
		setMenuHost(!leftCollapsed ? document.getElementById("sidebar-settings-slot") : null);
		if (view === "nodes") setMoreOpen(false);
	}, [view, leftCollapsed]);
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

	const connLabel = chat.ready
		? t("connected")
		: chat.status === "closed"
			? t("reconnecting")
			: t("connecting");
	const connClass = chat.ready ? "ok" : "busy";

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
		<header className="topbar" >
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
				<span className={`conn-dot ${connClass}`} title={connLabel} />
				<span className="conn-label">{connLabel}</span>
			</div>

			{view !== "nodes" && <button type="button" className="project-panel-toggle" title={t(leftCollapsed ? "expandProjects" : "collapseProjects")} aria-label={t(leftCollapsed ? "expandProjects" : "collapseProjects")} aria-expanded={!leftCollapsed} onClick={() => onOpenPanel("left")}><FiSidebar /></button>}
			<div className="header-location"><span title={chat.state?.cwd}>{projectName || t("desktopWorkspace")}</span><i>/</i><button className="conversation-title-button" title={t("treeTitle")} onClick={() => openSessionTree()}><strong title={conversationTitle}>{conversationTitle}</strong><span aria-hidden="true">⌄</span></button>{(interrupted || reminding || currentStep >= 0 || !!task?.plan?.awaitingConfirmation) && <button type="button" className={`header-task-progress${interrupted ? " interrupted" : reminding ? " reminding" : ""}`} title={t("taskProgress")} onClick={onOpenTask}><span aria-hidden="true">●</span>{interrupted ? t("toolRecoveryInterrupted") : reminding ? t("working") : task?.plan?.awaitingConfirmation ? t("taskProgress") : t("taskPlanPosition", { current: currentStep + 1, total: planItems.length })}</button>}</div>
			<div className="topbar-actions">
				<div className="panel-tab-bar">
				<div className="view-switch" role="tablist" aria-label={t("viewSwitch")}>
					{([
						["chat", t("chat"), <FiMessageSquare />],
						["terminal", t("terminal"), <FiTerminal />],
						["git", t("scmTab"), <FiGitBranch />],
					] as const).map(([id, label, icon]) => <button key={String(id)} type="button" role="tab" aria-label={String(label)} title={id === "git" && notGitRepo ? t("notGitRepoShort") : String(label)} aria-selected={view === id} aria-disabled={id === "git" && notGitRepo} className={view === id ? "active" : ""} onClick={() => { if (id !== "git" || !notGitRepo) onViewChange(id as TopBarProps["view"]); }}>{icon}<span>{label}</span>{id === "git" && !notGitRepo && gitChangeCount > 0 && <em className="tab-change-count">{gitChangeCount}</em>}</button>)}
					<button type="button" aria-label={t("dbTitle")} title={t("dbTitle")} onClick={onOpenDatabase}><FiDatabase /><span>{t("dbTitle")}</span></button>
					<button type="button" role="tab" aria-label={t("nodes")} title={t("nodes")} aria-selected={view === "nodes"} className={view === "nodes" ? "active" : ""} onClick={() => onViewChange("nodes")}><FiShare2 /><span>{t("nodes")}</span></button>
					{plugins.map(p => <button type="button" role="tab" key={p.id} aria-selected={view === `plugin:${p.id}`} className={view === `plugin:${p.id}` ? "active" : ""} title={p.error ? `${p.name}: ${p.error}` : p.description} onClick={() => onViewChange(`plugin:${p.id}`)}><span>{p.icon}</span><span>{p.name}{p.error ? " ⚠" : ""}</span></button>)}
				</div>


				</div>

				{/* Desktop toolbar — hidden on mobile (model/thinking move into the
				    input row; sound/lang fold into "⋯" below). Update-check and
				    GitHub link live only inside the "⋯" panel now, on both
				    desktop and mobile — no separate top-level chips for them. */}
				<div className="topbar-desktop">
					<ModelThinking
						state={chat.state ? { conversationId: chat.state.conversationId, runSettings: chat.state.runSettings, model: chat.state.model, routedModel: chat.state.routedModel, thinkingLevel: chat.state.thinkingLevel, availableThinkingLevels: chat.state.availableThinkingLevels } : null}
						models={chat.models}
						modelsLoading={chat.modelsLoading}
						send={send}
						onManageModels={onManageModels}
					/>

					<button
						type="button"
						className="chip"
						title={t("settingsTitle")}
						onClick={onOpenSettings}
					>
						<FiSettings />
						<span className="chip-sub">{t("settings")}</span>
					</button>

					<Dropdown
						trigger={
							<>
								<FiGlobe />
								<span className="chip-sub">
									{locale === "zh" ? t("langZh") : "EN"}
								</span>
							</>
						}
						open={langOpen}
						onOpenChange={setLangOpen}
					>
						<div className="dd-header">{t("language")}</div>
						{LANGUAGES.map((l) => (
							<DropdownItem
								key={l.value}
								active={locale === l.value}
								onClick={() => {
									setLocale(l.value);
									setLangOpen(false);
								}}
							>
								{l.label}
							</DropdownItem>
						))}
					</Dropdown>

				</div>

				<button
					type="button"
					className="chip newchat"
					data-tip={t("newChatTip")}
					onClick={() => send({ type: "new_chat" })}
				>
					<FiPlus />
					<span>{t("newChat")}</span>
				</button>

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
			<DesktopWindowControls />
		</header>
	);
}
