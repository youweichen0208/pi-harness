import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
	FiSearch,
	FiCode,
	FiFeather,
	FiMessageSquare,
	FiCheck,
	FiChevronDown,
	FiChevronRight,
	FiMoreHorizontal,
	FiList,
	FiPlus,
	FiSettings,
	FiX,
} from "react-icons/fi";
import type {
	ConversationSummary,
	DirBrowse,
	ProjectSummary,
	ProjectWorkspaceCatalog,
	ProjectWorkspaceAction,
	ServerMessage,
	ClientMessage,
	SessionSummary,
} from "../types";
import { workspaceProjects } from "../project-workspaces";
import { useDialogFocus } from "../use-dialog-focus";
import { randomUuid } from "../uuid";
import { FolderPickerModal } from "./FolderPickerModal";
import type { ConnStatus } from "../use-chat";
import { skillAwarePreview } from "../skill-block";
import { conversationDisplayTitle } from "../conversation-display-title";
import { useI18n } from "../i18n";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  this entire panel during streaming instead of re-reconciling the file tree
 *  and conversation lists on every delta. Add a prop here when adding a chat
 *  field usage — TypeScript enforces it at the call site. */
interface LeftPanelProps {
	directoryCollapsed: boolean;
	onToggleDirectory: () => void;
	notesOpen: boolean;
	scratchOpen: boolean;
	onNavigate: (target: "chat" | "notes" | "playground") => void;
	notesList: ReactNode;
	onOpenSettings: () => void;
	onNewChat: () => void;
	ready: boolean;
	status: ConnStatus;
	cwd: string;
	sessionFile: string | null;
	conversations: ConversationSummary[];
	sessions: SessionSummary[];
	projects: ProjectSummary[];
	projectWorkspaces: ProjectWorkspaceCatalog | null;
	projectWorkspaceResult: Extract<ServerMessage, { type: "project_workspace_result" }> | null;
	/** Latest workspace-picker listing (drives FolderPickerModal). */
	dirBrowse: DirBrowse | null;
	activeConversationId: string;
	send: (
		msg:
			| { type: "new_chat" }
			| { type: "list_sessions" }
			| { type: "list_projects" }
			| Extract<ClientMessage, { type: "list_project_workspaces" | "project_workspace_action" }>
			| { type: "switch_session"; path: string }
			| { type: "switch_conversation"; id: string }
			| { type: "set_cwd"; path: string; source?: "ui" }
			| { type: "remove_project"; path: string }
			| { type: "delete_session"; path: string }
			| { type: "rename_session"; path: string; name: string }
			| { type: "browse_dirs"; path?: string },
	) => boolean;
	/** True while the panel is actually on screen (desktop: always; mobile:
	 *  only while the drawer is open). Drives lazy loading of the session
	 *  list + recent projects — both scan session files on disk. */
	active: boolean;
}

function formatModified(ts: number, yesterday: string): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	if (sameDay) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	const previous = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
	if (d.toDateString() === previous.toDateString()) return yesterday;
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

function WorkspaceBook() {
	return <svg className="workspace-book" viewBox="0 0 20 24" aria-hidden="true"><rect x="2" y="1.5" width="16" height="21" rx="1.5" /><path d="M6 2v20M11 6h4" /></svg>;
}

export const LeftPanel = memo(function LeftPanel({
	directoryCollapsed, onToggleDirectory, notesOpen, scratchOpen, onNavigate, notesList, onOpenSettings, onNewChat, ready, status, cwd, sessionFile, conversations, sessions, projects, projectWorkspaces, projectWorkspaceResult, dirBrowse, activeConversationId, send, active }: LeftPanelProps) {
	const { t, locale } = useI18n();
	const [selectedWorkspace, setSelectedWorkspace] = useState(() => {
		try { return localStorage.getItem("pi-harness:project-workspace") ?? ""; } catch { return ""; }
	});
	const [workspaceForm, setWorkspaceForm] = useState<"create" | string | null>(null);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [groupQuery, setGroupQuery] = useState("");
	const switcherRef = useRef<HTMLDivElement>(null);
	const switcherButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!workspaceOpen) return;
		const outside = (event: PointerEvent) => { if (!switcherRef.current?.contains(event.target as Node)) setWorkspaceOpen(false); };
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [workspaceOpen]);
	const workspaceDialog = useDialogFocus<HTMLFormElement>(!!workspaceForm);
	const [workspaceName, setWorkspaceName] = useState("");
	const previousWorkspaceName = useRef({ id: "", name: "" });
	const [workspaceQuery, setWorkspaceQuery] = useState("");
	const [workspaceError, setWorkspaceError] = useState("");
	const [workspacePending, setWorkspacePending] = useState<{ requestId: string; kind: ProjectWorkspaceAction["kind"] } | null>(null);
	const selectedGroup = projectWorkspaces?.workspaces.find((group) => group.id === selectedWorkspace);
	const workspaceBusy = !ready || status !== "open" || !projectWorkspaces || !!workspacePending;
	/** An empty catalog offers creation without inventing a default group. */

	const chooseWorkspace = (id: string) => {
		setSelectedWorkspace(id); setWorkspaceQuery(""); setWorkspaceError(""); setWorkspaceOpen(false);
		try { localStorage.setItem("pi-harness:project-workspace", id); } catch { /* optional preference */ }
	};
	useEffect(() => {
		if (projectWorkspaces && !selectedGroup) {
			const next = projectWorkspaces.workspaces[0]?.id ?? "";
			if (next !== selectedWorkspace) chooseWorkspace(next);
		}
	}, [projectWorkspaces, selectedWorkspace, selectedGroup]);
	useEffect(() => {
		const previous = previousWorkspaceName.current;
		const next = { id: selectedGroup?.id ?? "", name: selectedGroup?.name ?? "" };
		// A remote rename updates an untouched form, preserving a local draft.
		setWorkspaceName((draft) => previous.id !== next.id || draft === previous.name ? next.name : draft);
		previousWorkspaceName.current = next;
	}, [selectedGroup?.id, selectedGroup?.name]);
	useEffect(() => {
		if (!workspacePending || projectWorkspaceResult?.requestId !== workspacePending.requestId) return;
		if (projectWorkspaceResult.ok) {
			if (workspacePending.kind === "create") { chooseWorkspace(projectWorkspaceResult.workspaceId ?? ""); onNavigate("chat"); }
			if (workspacePending.kind === "add") setPicking(false);
			setWorkspaceForm(null);
			setWorkspaceError("");
		} else setWorkspaceError(projectWorkspaceResult.error ?? t("workspaceSaveFailed"));
		setWorkspacePending(null);
	}, [projectWorkspaceResult, workspacePending, t]);
	useEffect(() => {
		if (status !== "open") {
			setWorkspacePending(null);
			setWorkspaceError("");
		}
	}, [status]);
	const changeWorkspace = (action: ProjectWorkspaceAction) => {
		if (workspaceBusy || !projectWorkspaces) return;
		const requestId = randomUuid();
		if (send({ type: "project_workspace_action", requestId, revision: projectWorkspaces.revision, action })) {
			setWorkspacePending({ requestId, kind: action.kind }); setWorkspaceError("");
		} else setWorkspaceError(t("workspaceSaveFailed"));
	};
	const currentFile = sessionFile;
	const currentCwd = cwd;
	// Two-step delete confirm: which row ("proj:<path>" / "sess:<path>") is
	// awaiting its second click. Mirrors the settings-panel uninstall pattern.
	const [confirmDel, setConfirmDel] = useState<string | null>(null);

	// Inline session rename: which transcript path is being edited, and the
	// draft text. Empty draft clears the name (list falls back to first message).
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [openMenu, setOpenMenu] = useState<string | null>(null);
	const [collapsedActive, setCollapsedActive] = useState(false);
	useEffect(() => setCollapsedActive(false), [cwd]);
	useEffect(() => {
		if (!openMenu) return;
		const closeOutside = (event: PointerEvent) => {
			const zone = event.target instanceof Element ? event.target.closest<HTMLElement>(".lp-menu-zone") : null;
			if (zone?.dataset.menuKey !== openMenu) setOpenMenu(null);
		};
		const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpenMenu(null); };
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeEscape);
		return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
	}, [openMenu]);

	// "Open folder": the recent-project list only ever grew as a side effect
	// of the /cwd slash command — this is the panel's own entry point. Opens
	// a server-driven directory picker (see FolderPickerModal for why a
	// native OS dialog can't work here).
	const [picking, setPicking] = useState(false);

	// 乐观项目切换反馈：点击后立即高亮 + 转圈，等 cwd 真正变过来再清掉。
	// "warm" 切换很快，这段几乎一闪而过；"cold" 切换（需要真正恢复会话运行时）
	// 期间也能让用户立刻知道点击生效了，而不是干等服务端往返。
	const [pendingCwd, setPendingCwd] = useState<string | null>(null);
	useEffect(() => {
		if (pendingCwd && cwd === pendingCwd) setPendingCwd(null);
	}, [cwd, pendingCwd]);
	// 兜底：万一切换失败/服务端从未回包，别让转圈永远卡住。
	useEffect(() => {
		if (!pendingCwd) return;
		const timer = setTimeout(() => setPendingCwd(null), 15000);
		return () => clearTimeout(timer);
	}, [pendingCwd]);

	// Lazy load + stale-while-revalidate: (re)fetch whenever the panel is on
	// screen, the connection is ready, or the workspace changed. Old data
	// stays visible while the fresh listing is in flight.
	useEffect(() => {
		if (!active || !ready || status !== "open") return;
		if (!cwd) return;
		send({ type: "list_sessions" });
		send({ type: "list_projects" });
		send({ type: "list_project_workspaces" });
	}, [active, ready, status, cwd, send]);

	const displayName = (s: SessionSummary): string => {
		// s.name is a user rename (kept verbatim); the fallback is the SDK's
		// raw first-user-message, which for a skill invocation is the entire
		// expanded SKILL.md body — collapse that to "skill:name · args"
		// instead of dumping (and truncating mid-sentence) the raw text.
		const title = s.name || convByFile.get(s.path)?.title || skillAwarePreview(s.firstMessage);
		return conversationDisplayTitle(title.length > 0 ? title : t("emptyChat"), s.firstMessage, s.name, s.messageCount, locale);
	};

	// 运行中的对话原来单独列一段，放在历史对话上面。问题是它平时是空的，一新建
	// 对话就突然冒出来一段带标题的区块，看起来像侧栏多了个列表；而那条对话的
	// transcript 其实已经在磁盘上、也在 list_sessions 的返回里，只是被过滤掉了。
	//
	// 现在合成一段。运行中的状态不靠分区表达，靠历史行自己的圆点（绿色脉冲）。
	// 要紧的是点击行为得跟着分流：有活运行时的那条必须走 switch_conversation
	// （按运行时 id 切过去），不能走 switch_session——后者会从磁盘重新恢复一个
	// 已经有活运行时的对话，等于把它重建一遍。
	const convByFile = new Map<string, ConversationSummary>();
	for (const conv of conversations) {
		if (conv.sessionFile) convByFile.set(conv.sessionFile, conv);
	}
	// 刚新建、还没落盘（或者 list_sessions 还没刷新到）的对话，在 sessions 里
	// 找不到对应项。这些单独补在列表最前面，否则新建的对话会从侧栏里整个消失
	// ——这正是「新建会话不立刻出现在历史对话列表」的成因。
	const sessionPaths = new Set(sessions.map((sess) => sess.path));
	const pendingConvs = conversations.filter(
		(conv) => !conv.sessionFile || !sessionPaths.has(conv.sessionFile),
	);

	const projectName = (path: string): string => {
		const normalized = path.replace(/\\/g, "/").replace(/\/$/, "") || "/";
		if (normalized === "/" || /^[A-Za-z]:$/.test(normalized)) return t("rootDir");
		if (/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalized)) return "~";
		return normalized.split("/").at(-1) || normalized;
	};
	const projectActivity = (project: ProjectSummary) => Math.max(
		project.lastUsed,
		project.lastConversationAt ?? 0,
		project.path === currentCwd && sessions.length ? Math.max(...sessions.map((session) => session.modified)) : 0,
	);
	const sortedProjects = workspaceProjects(projects, projectWorkspaces, selectedWorkspace, workspaceQuery).sort((a, b) =>
		Number(b.path === currentCwd) - Number(a.path === currentCwd) ||
		projectActivity(b) - projectActivity(a) || a.path.localeCompare(b.path),
	);

	const history = (
			<div className="panel-sessions">
				<div className="sessions-scroll">
					{sessions.length === 0 && pendingConvs.length === 0 && (
						<div className="panel-empty">{t("noHistory")}</div>
					)}
					{pendingConvs.map((c) => {
						const active = activeConversationId === c.id;
						return (
							<button
								type="button"
								key={c.id}
								className={`session-item ${active ? "active" : ""}`}
								title={`${c.title}\n${
									active ? t("current") : t("messageCount", { n: c.messageCount })
								}`}
								onClick={() => {
									if (!active) send({ type: "switch_conversation", id: c.id });
								}}
							>
								<span
									className="session-dot"
									style={{ visibility: active && ready && status === "open" ? "visible" : "hidden" }}
									title={active && ready && status === "open" ? t("connected") : undefined}
								/>
								<span className="session-info">
									<span className="session-title">{conversationDisplayTitle(c.title, undefined, undefined, c.messageCount, locale)}</span>
									{!!c.branchPoints && <small>{t("treeBranches", { n: c.branchPoints })}</small>}
									{c.parentSessionPath && <small title={c.parentSessionPath}>{t("treeDerived", { name: sessions.find(parent => parent.path === c.parentSessionPath)?.name || c.parentSessionPath.split(/[\\/]/).pop() || "" })}</small>}
								</span>
								<span className="session-time">{formatModified(c.createdAt ?? Date.now(), t("yesterday"))}</span>
							</button>
						);
					})}
					{sessions.map((s) => {
						const conv = convByFile.get(s.path);
						const active = conv
							? activeConversationId === conv.id
							: currentFile === s.path;
						if (renaming === s.path) {
							return (
								<form
									className="lp-inline-form"
									key={s.path}
									onSubmit={(e) => {
										e.preventDefault();
										send({
											type: "rename_session",
											path: s.path,
											name: renameDraft.trim(),
										});
										setRenaming(null);
									}}
								>
									{/* biome-ignore lint/a11y/noAutofocus: opened by an explicit click */}
									<input
										autoFocus
										className="lp-inline-input"
										placeholder={t("renameSessionPlaceholder")}
										value={renameDraft}
										onChange={(e) => setRenameDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Escape") setRenaming(null);
										}}
									/>
									<button type="submit" className="lp-inline-ok" title={t("confirm")}>
										<FiCheck />
									</button>
									<button
										type="button"
										className="lp-inline-cancel"
										title={t("cancel")}
										onClick={() => setRenaming(null)}
									>
										<FiX />
									</button>
								</form>
							);
						}
						return (
							<div
								className="lp-row"
								key={s.path}
								onMouseLeave={() =>
									setConfirmDel((k) => (k === `sess:${s.path}` ? null : k))
								}
							>
								<button
									type="button"
									className={`session-item ${active ? "active" : ""}`}
									title={`${s.path}\n${
										active
											? t("current")
											: t("messageCount", { n: s.messageCount })
									}`}
									onClick={() => {
										if (active) return;
										send(
											conv
												? { type: "switch_conversation", id: conv.id }
												: { type: "switch_session", path: s.path },
										);
									}}
								>
									<span
										className="session-dot"
									style={{ visibility: active && ready && status === "open" ? "visible" : "hidden" }}
										title={active && ready && status === "open" ? t("connected") : undefined}
									/>
									<span className="session-info">
										<span className="session-title">{displayName(s)}</span>
										{!!(conv?.branchPoints ?? s.branchPoints) && <small>{t("treeBranches", { n: conv?.branchPoints ?? s.branchPoints ?? 0 })}</small>}
										{s.parentSessionPath && <small title={s.parentSessionPath}>{t("treeDerived", { name: sessions.find(parent => parent.path === s.parentSessionPath)?.name || s.parentSessionPath.split(/[\\/]/).pop() || "" })}</small>}
									</span>
									{s.source === "tui" && (
										<span className="session-src" title={t("tuiTip")}>
											TUI
										</span>
									)}
									<span className="session-time">
										{formatModified(s.modified, t("yesterday"))}
									</span>
								</button>
								<div className={`lp-menu-zone${openMenu === `sess:${s.path}` ? " is-open" : ""}`} data-menu-key={`sess:${s.path}`}>
									<button type="button" className="lp-menu-trigger" aria-label={`${displayName(s)} · ${t("more")}`} aria-haspopup="menu" aria-expanded={openMenu === `sess:${s.path}`} onClick={() => setOpenMenu((key) => key === `sess:${s.path}` ? null : `sess:${s.path}`)}><FiMoreHorizontal /></button>
									{openMenu === `sess:${s.path}` && <div className="lp-menu-popover" role="menu">
										<button type="button" role="menuitem" onClick={() => { setRenameDraft(s.name ?? displayName(s)); setRenaming(s.path); setOpenMenu(null); }}>{t("renameSession")}</button>
										<button type="button" role="menuitem" className={confirmDel === `sess:${s.path}` ? "danger" : ""} onClick={() => {
											if (confirmDel === `sess:${s.path}`) { send({ type: "delete_session", path: s.path }); setConfirmDel(null); setOpenMenu(null); }
											else setConfirmDel(`sess:${s.path}`);
										}}>{confirmDel === `sess:${s.path}` ? t("deleteSessionConfirm") : t("deleteSession")}</button>
									</div>}
								</div>
							</div>
						);
					})}
				</div>
			</div>
	);
	return (
		<aside className={`panel panel-left workspace-navigation compact-navigation ${directoryCollapsed ? "directory-collapsed" : ""}`}>
			<div className="global-navigation">
				<div className="compact-workspace-switcher" ref={switcherRef} onKeyDown={event => {
					if (event.key === "Escape") { setWorkspaceOpen(false); switcherButton.current?.focus(); }
					if (workspaceOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
						const buttons = Array.from(switcherRef.current?.querySelectorAll<HTMLButtonElement>(".workspace-picker button:not(:disabled)") ?? []);
						if (buttons.length) { event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus(); }
					}
				}}>
					<button ref={switcherButton} className="compact-workspace-trigger" title={selectedGroup?.name ?? t("workspaceSelect")} aria-label={t("workspaceSelect")} aria-expanded={workspaceOpen} aria-haspopup="dialog" onClick={() => { setGroupQuery(""); setWorkspaceOpen(value => !value); }}>
						<img src="/icon/1a-mark.svg" alt="pi-harness" /><span>{selectedGroup?.name ?? t("workspaceNoneSelected")}</span><FiChevronDown />
					</button>
					{workspaceOpen && <div className="workspace-picker" role="dialog" aria-label={t("workspaceSelect")}>
						<input autoFocus type="search" aria-label={t("workspaceFilter")} placeholder={t("workspaceFilter")} value={groupQuery} onChange={event => setGroupQuery(event.target.value)} />
						<div className="workspace-list">
					{projectWorkspaces?.workspaces.filter(group => group.name.toLocaleLowerCase().includes(groupQuery.toLocaleLowerCase())).map(group => <div className="workspace-list-row" key={group.id}>
						<button className={selectedWorkspace === group.id ? "active" : ""} disabled={!!workspacePending} onClick={() => { chooseWorkspace(group.id); onNavigate("chat"); }}><WorkspaceBook /><span>{group.name}</span>{selectedWorkspace === group.id && <FiCheck className="workspace-selected-check" />}</button>
						<div className="lp-menu-zone" data-menu-key={`ws:${group.id}`}><button className="lp-menu-trigger" aria-label={`${group.name} · ${t("more")}`} aria-haspopup="menu" aria-expanded={openMenu === `ws:${group.id}`} onClick={() => setOpenMenu(openMenu === `ws:${group.id}` ? null : `ws:${group.id}`)}><FiMoreHorizontal /></button>
							{openMenu === `ws:${group.id}` && <div className="lp-menu-popover" role="menu">
								<button role="menuitem" disabled={workspaceBusy} onClick={() => { setWorkspaceName(group.name); setWorkspaceForm(group.id); setOpenMenu(null); setWorkspaceOpen(false); }}>{t("workspaceRename")}</button>
								<button role="menuitem" disabled={workspaceBusy} onClick={() => { if (window.confirm(t("workspaceDeleteHint"))) { changeWorkspace({ kind: "delete", id: group.id }); setOpenMenu(null); } }}>{t("workspaceDelete")}</button>
							</div>}
						</div>
					</div>)}
						{!projectWorkspaces?.workspaces.some(group => group.name.toLocaleLowerCase().includes(groupQuery.toLocaleLowerCase())) && <p className="panel-empty">{t("workspaceFilterEmpty")}</p>}
						</div>
						<button className="workspace-picker-create" disabled={workspaceBusy} onClick={() => { setWorkspaceName(""); setWorkspaceForm("create"); setWorkspaceOpen(false); }}><FiPlus />{t("workspaceNew")}</button>
					</div>}
				</div>
				{!notesOpen && selectedGroup && <label className="navigation-search"><FiSearch aria-hidden="true" /><input className="workspace-project-search" type="search" aria-label={t("workspaceSearch")} placeholder={t("workspaceSearch")} value={workspaceQuery} onChange={event => setWorkspaceQuery(event.target.value)} /></label>}
				<nav className="global-entries">
					<button title={t("notesChat")} className={!notesOpen && !scratchOpen ? "active" : ""} onClick={() => onNavigate("chat")}><FiMessageSquare /><span>{t("notesChat")}</span></button>
					<button title={t("notesPlayground")} className={scratchOpen ? "active" : ""} onClick={() => onNavigate("playground")}><FiCode /><span>{t("notesPlayground")}</span></button>
					<button title={t("notesTitle")} className={notesOpen ? "active" : ""} onClick={() => { onNavigate("notes"); }}><FiFeather /><span>{t("notesTitle")}</span></button>
				</nav>
				{workspaceError && <p className="workspace-group-error" role="alert">{workspaceError}</p>}

			<button className="compact-project-shortcut" title={t("workspaceProjects")} aria-label={t("workspaceProjects")} onClick={() => onNavigate("chat")}><FiList /></button>
			<div className="workspace-directory">
			{notesOpen ? notesList : <>
			{!selectedGroup && <button className="compact-empty-create" disabled={workspaceBusy} onClick={() => { setWorkspaceName(""); setWorkspaceForm("create"); }}>{t("workspaceNew")}</button>}

			{selectedGroup && <div className="panel-projects">
				{/* 加项目收进分组标题行：它是个偶尔用一次的动作，不值得在列表
				    最上面常驻一整行。 */}
				<div className="panel-section-title">
					<span className="workspace-directory-label"><FiList aria-hidden="true" />{t("workspaceProjects")}</span>
					<button className="lp-add-project" aria-label={t("workspaceAddProject")} title={t("workspaceAddProject")} disabled={workspaceBusy} onClick={() => setPicking(true)}><FiPlus /></button>
				</div>
				<div className="projects-scroll">
					{sortedProjects.length === 0 && <div className="panel-empty">{t(workspaceQuery ? "workspaceNoMatches" : "workspaceEmpty")}</div>}
					{sortedProjects.map((p) => {
						const active = currentCwd === p.path;
						const pending = !active && pendingCwd === p.path;
						const expanded = active && !collapsedActive;
						const count = active ? Math.max(p.conversationCount ?? 0, sessions.length + pendingConvs.length) : p.conversationCount ?? 0;
						return (
							<div
								className="lp-row"
								key={p.path}
								onMouseLeave={() =>
									setConfirmDel((k) => (k === `proj:${p.path}` ? null : k))
								}
							>
								<button
									type="button"
									className={`project-item ${active ? "active" : ""} ${pending ? "pending" : ""}`}
									aria-expanded={expanded}
									title={p.path}
									onClick={() => {
										if (active) setCollapsedActive((value) => !value);
										else {
											setCollapsedActive(false);
											setPendingCwd(p.path);
										send({ type: "set_cwd", path: p.path, source: "ui" });
										}
									}}
								>
									{expanded ? <FiChevronDown className="project-chevron" /> : <FiChevronRight className="project-chevron" />}
									<span className="project-info">
										<span className="project-name">{projectName(p.path)}</span>
										<span className="project-count">· {count}</span>
									</span>
									{pending ? (
										<span className="thinking-spinner project-spinner" aria-hidden="true" />
									) : (
										<span className="project-time">
											{projectActivity(p) ? formatModified(projectActivity(p), t("yesterday")) : ""}
										</span>
									)}
								</button>
								<div className={`lp-menu-zone${openMenu === `proj:${p.path}` ? " is-open" : ""}`} data-menu-key={`proj:${p.path}`}>
									{active && <button type="button" className="lp-project-new" title={t("newChat")} aria-label={`${projectName(p.path)} · ${t("newChat")}`} disabled={!ready} onClick={onNewChat}><FiPlus /></button>}
									<button type="button" className="lp-menu-trigger" aria-label={`${projectName(p.path)} · ${t("more")}`} aria-haspopup="menu" aria-expanded={openMenu === `proj:${p.path}`} onClick={() => setOpenMenu((key) => key === `proj:${p.path}` ? null : `proj:${p.path}`)}><FiMoreHorizontal /></button>
									{openMenu === `proj:${p.path}` && <div className="lp-menu-popover workspace-project-menu" role="menu">
										{active && <button type="button" role="menuitem" disabled={!ready} onClick={() => { setOpenMenu(null); onNewChat(); }}>{t("newChat")}</button>}
										<button type="button" role="menuitem" disabled={workspaceBusy} className={confirmDel === `proj:${p.path}` ? "danger" : ""} onClick={() => {
											if (confirmDel === `proj:${p.path}`) { changeWorkspace({ kind: "remove", id: selectedGroup.id, path: p.path }); setConfirmDel(null); setOpenMenu(null); }
											else setConfirmDel(`proj:${p.path}`);
										}}>{confirmDel === `proj:${p.path}` ? t("deleteProjectConfirm") : t("workspaceRemoveProject")}</button>
									</div>}
								</div>
								{expanded && history}
							</div>
						);
					})}
				</div>
			</div>}
			</>}
			</div>
				<div className="sidebar-footer"><span className="sidebar-connection"><i className={ready ? "ok" : "busy"} />{t(ready ? "connected" : "connecting")}</span><span id="sidebar-settings-slot"><button type="button" title={t("settings")} onClick={onOpenSettings}><FiSettings /><span>{t("settings")}</span></button></span></div>
			</div>
			{workspaceForm && <div className="wiki-modal-backdrop"><form ref={workspaceDialog} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setWorkspaceForm(null); } }} className="wiki-confirm workspace-name-dialog" role="dialog" aria-modal="true" aria-label={t(workspaceForm === "create" ? "workspaceNew" : "workspaceRename")} onSubmit={event => { event.preventDefault(); changeWorkspace(workspaceForm === "create" ? { kind: "create", name: workspaceName } : { kind: "rename", id: workspaceForm, name: workspaceName }); }}>
				<h2>{t(workspaceForm === "create" ? "workspaceNew" : "workspaceRename")}</h2>
				<label className="workspace-name-field"><span>{t("workspaceName")}</span><input autoFocus placeholder={t("workspaceName")} aria-label={t("workspaceName")} value={workspaceName} maxLength={80} onChange={event => setWorkspaceName(event.target.value)} /></label>
				{workspaceError && <p role="alert">{workspaceError}</p>}
				<div className="workspace-name-actions"><button type="button" onClick={() => setWorkspaceForm(null)}>{t("cancel")}</button><button disabled={workspaceBusy || !workspaceName.trim()}>{t(workspaceForm === "create" ? "workspaceCreate" : "workspaceRename")}</button></div>
			</form></div>}

			{picking && selectedGroup && (
				<FolderPickerModal
					dirBrowse={dirBrowse}
					busy={workspaceBusy}
					error={workspaceError}
					pickLabel={t("workspaceAddProject")}
					onBrowse={(path) => send({ type: "browse_dirs", path })}
					onPick={(path) => {
						changeWorkspace({ kind: "add", id: selectedGroup.id, path });
					}}
					onClose={() => setPicking(false)}
				/>
			)}
		</aside>
	);
});
