import { useEffect, useRef, useState } from "react";
import { randomUuid } from "../uuid";
import {
	FiCheck,
	FiChevronDown,
	FiEdit2,
	FiFolder,
	FiFolderPlus,
	FiMenu,
	FiPlus,
	FiTerminal,
	FiX,
} from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { ClientMessage, ProjectWorkspaceAction } from "../types";
import { TermXterm } from "./TermXterm";
import { FolderPickerModal } from "./FolderPickerModal";
import { useT } from "../i18n";
import { useDialogFocus } from "../use-dialog-focus";
import { PROJECT_WORKSPACE_SELECTION_EVENT, selectProjectWorkspace, selectedProjectWorkspace } from "../project-workspaces";
import { WorkspaceBook } from "./WorkspaceBook";

interface TerminalPanelProps {
	focusRequest?: { id: string };
	active: boolean;
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	terminal: {
		create: (meta: TerminalMeta) => void;
		close: (id: string) => void;
		register: (
			conversationId: string,
			id: string,
			writer: { write(data: string): void; dispose(): void },
		) => () => void;
		restart: (id: string) => void;
	};
}

/** Inline rename: Enter/blur commits, Escape cancels. */
function TabRenameInput({ value, label, hint, onSubmit, onCancel }: { value: string; label: string; hint: string; onSubmit: (next: string) => void; onCancel: () => void }) {
	const [text, setText] = useState(value);
	const finished = useRef(false);
	const inputRef = useRef<HTMLInputElement>(null);
	// Focus + select explicitly: the tab strip re-renders whenever terminal_list
	// arrives, and autoFocus alone does not reliably keep the caret in the field.
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	const finish = (commit: boolean) => {
		if (finished.current) return;
		finished.current = true;
		const next = text.trim();
		if (commit && next && next !== value) onSubmit(next);
		else onCancel();
	};
	return (
		<form className="term-tab-rename" onSubmit={(event) => { event.preventDefault(); finish(true); }}>
			{/* biome-ignore lint/a11y/noAutofocus: opened by an explicit double-click / F2 */}
			<input
				ref={inputRef}
				autoFocus
				value={text}
				maxLength={80}
				aria-label={label}
				aria-description={hint}
				title={hint}
				onBlur={() => finish(true)}
				placeholder={label}
				onChange={(event) => setText(event.target.value)}
				onFocus={(event) => event.currentTarget.select()}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); return; }
					if (event.key === "Enter") { event.preventDefault(); finish(true); }
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						finish(false);
					}
				}}
			/>
		</form>
	);
}

/**
 * Built-in terminal — two panes:
 *   left : Workspace, project directories and terminal tabs
 *          (on mobile this whole column slides in as a drawer)
 *   right: the active terminal (one xterm per tab, kept mounted)
 */
export function TerminalPanel({ chat, send, terminal, active, focusRequest }: TerminalPanelProps) {
	const t = useT();
	const workspaceCwd = chat.state?.cwd ?? "";
	const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
	const projectPathHint = (path: string) => { const parts = path.split(/[\\/]/).filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path; };
	const [selectedWorkspace, setSelectedWorkspace] = useState(selectedProjectWorkspace);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [workspaceForm, setWorkspaceForm] = useState(false);
	const [newWorkspaceName, setNewWorkspaceName] = useState("");
	const [picking, setPicking] = useState(false);
	const [workspaceError, setWorkspaceError] = useState("");
	const [workspacePending, setWorkspacePending] = useState<{ requestId: string; kind: ProjectWorkspaceAction["kind"]; path?: string } | null>(null);
	const workspaceMenuRef = useRef<HTMLDivElement>(null);
	const workspaceDialogRef = useDialogFocus<HTMLFormElement>(workspaceForm);
	const selectedGroup = chat.projectWorkspaces?.workspaces.find(group => group.id === selectedWorkspace);
	const workspacePathReady = !selectedGroup || selectedGroup.paths.includes(workspaceCwd);
	const workspaceBusy = !chat.ready || !active || !chat.projectWorkspaces || !!workspacePending;
	const chooseWorkspace = (id: string) => { setSelectedWorkspace(id); selectProjectWorkspace(id); setWorkspaceOpen(false); setWorkspaceError(""); };
	useEffect(() => { if (active) send({ type: "list_project_workspaces" }); }, [active, send]);
	useEffect(() => {
		const sync = (event: Event) => setSelectedWorkspace((event as CustomEvent<string>).detail);
		window.addEventListener(PROJECT_WORKSPACE_SELECTION_EVENT, sync);
		return () => window.removeEventListener(PROJECT_WORKSPACE_SELECTION_EVENT, sync);
	}, []);
	useEffect(() => {
		if (!chat.projectWorkspaces || selectedGroup) return;
		const first = chat.projectWorkspaces.workspaces[0]?.id ?? "";
		if (first !== selectedWorkspace) chooseWorkspace(first);
	}, [chat.projectWorkspaces, selectedGroup, selectedWorkspace]);
	useEffect(() => {
		if (!workspaceOpen) return;
		const outside = (event: PointerEvent) => { if (!workspaceMenuRef.current?.contains(event.target as Node)) setWorkspaceOpen(false); };
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [workspaceOpen]);
	useEffect(() => {
		if (!workspacePending || chat.projectWorkspaceResult?.requestId !== workspacePending.requestId) return;
		if (chat.projectWorkspaceResult.ok) {
			if (workspacePending.kind === "create") {
				chooseWorkspace(chat.projectWorkspaceResult.workspaceId ?? "");
				setWorkspaceForm(false);
				setPicking(true);
			} else if (workspacePending.kind === "add") {
				setPicking(false);
				if (workspacePending.path) send({ type: "set_cwd", path: workspacePending.path, source: "ui" });
			}
			setWorkspaceError("");
		} else setWorkspaceError(chat.projectWorkspaceResult.error ?? t("workspaceSaveFailed"));
		setWorkspacePending(null);
	}, [chat.projectWorkspaceResult, workspacePending, send, t]);
	const changeWorkspace = (action: ProjectWorkspaceAction, path?: string) => {
		if (workspaceBusy || !chat.projectWorkspaces) return;
		const requestId = randomUuid();
		if (send({ type: "project_workspace_action", requestId, revision: chat.projectWorkspaces.revision, action })) {
			setWorkspacePending({ requestId, kind: action.kind, path });
			setWorkspaceError("");
		} else setWorkspaceError(t("workspaceSaveFailed"));
	};
	const [activeId, setActiveId] = useState<string | null>(null);
	const [showAllTerminals, setShowAllTerminals] = useState(false);
	/** Terminal tab currently in inline-rename mode. */
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const focusedRequest = useRef<typeof focusRequest>();

	// Mobile: the left column (projects + tabs) slides in as a drawer.
	const [sideOpen, setSideOpen] = useState(false);

	// When the connection drops the server kills all PTYs and the reducer clears
	// the tab list — make sure the active selection doesn't dangle.
	useEffect(() => {
		if (chat.terminals.length === 0) setActiveId(null);
		else if (!chat.terminals.some((t) => t.id === activeId)) {
			setActiveId(chat.terminals[chat.terminals.length - 1].id);
		}
		if (renamingId && !chat.terminals.some((t) => t.id === renamingId)) setRenamingId(null);
	}, [chat.terminals, activeId, renamingId]);

	useEffect(() => {
		if (!focusRequest || focusedRequest.current === focusRequest || !chat.terminals.some(item => item.id === focusRequest.id)) return;
		focusedRequest.current = focusRequest;
		setActiveId(focusRequest.id);
	}, [focusRequest, chat.terminals]);


	// -- tab management --------------------------------------------------------

	const openTab = (
		meta: Omit<TerminalMeta, "running" | "exitCode" | "id" | "conversationId" | "cols" | "rows"> &
			Partial<Pick<TerminalMeta, "cols" | "rows">>,
	) => {
		if (!chat.ready) return; // topbar already shows the connection state
		const id = randomUuid();
		const conversationId = chat.activeConversationId || chat.state?.conversationId || "";
		terminal.create({
			...meta,
			id,
			conversationId,
			cols: meta.cols ?? 80,
			rows: meta.rows ?? 24,
			running: true,
			exitCode: null,
		});
		setActiveId(id);
		setSideOpen(false);
	};

	const openShell = () => {
		if (!workspacePathReady) return;
		openTab({
			title: t("terminalTitle", { n: chat.terminals.length + 1 }),
			cwd: workspaceCwd,
		});
	};


	const closeTab = (id: string) => {
		const tab = chat.terminals.find((item) => item.id === id);		if (tab) send({ type: "terminal_kill", terminalId: id, conversationId: tab.conversationId });
		terminal.close(id);
		if (activeId === id) {
			const rest = chat.terminals.filter((t) => t.id !== id);
			setActiveId(rest.length > 0 ? rest[rest.length - 1].id : null);
		}
	};

	const commitRename = (id: string, title: string) => {
		const tab = chat.terminals.find((item) => item.id === id);
		setRenamingId(null);
		if (!tab || tab.title === title) return;
		send({ type: "terminal_rename", terminalId: id, title, conversationId: tab.conversationId });
	};


	const requiredIds = new Set([activeId, renamingId].filter(Boolean));
	const visibleIds = new Set(requiredIds);
	for (const tab of chat.terminals) {
		if (visibleIds.size >= 3) break;
		visibleIds.add(tab.id);
	}
	const visibleTerminals = showAllTerminals ? chat.terminals : chat.terminals.filter(tab => visibleIds.has(tab.id));
	const terminalList = <div className="term-tabs-block" role="group" aria-label={t("builtinTerminal")}>
		<div className="panel-body">
			{visibleTerminals.map((tab) => (
				<div key={tab.id} className={`term-tab ${tab.id === activeId ? "active" : ""} ${renamingId === tab.id ? "renaming" : ""}`}>
					{renamingId === tab.id ? (
						<>
							{/* Keep the run/exit dot visible while renaming: it is the only
							    status cue on the row (green = live PTY). */}
							<span className={`term-tab-dot ${tab.running ? "run" : "exit"}`} title={tab.running ? undefined : t("exited", { code: tab.exitCode === null ? "" : ` ${tab.exitCode}` })} />
							<TabRenameInput
								value={tab.title}
								label={t("terminalRename")}
								hint={t("terminalRenameKeys")}
								onSubmit={(next) => commitRename(tab.id, next)}
								onCancel={() => setRenamingId(null)}
							/>
						</>
					) : (
						<button
							type="button"
							className="term-tab-main"
							aria-pressed={tab.id === activeId}
							title={`${tab.cwd}${tab.command ? `\n> ${tab.command.command}` : ""}\n${t("terminalRenameHint")}`}
							onClick={() => { setActiveId(tab.id); setSideOpen(false); }}
							onDoubleClick={(event) => { event.preventDefault(); setRenamingId(tab.id); }}
							onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); setRenamingId(tab.id); } }}
						>

							<span className={`term-tab-dot ${tab.running ? "run" : "exit"}`} title={tab.running ? t("terminalConnected") : t("exited", { code: tab.exitCode === null ? "" : ` ${tab.exitCode}` })} />
							<span className="term-tab-title">{tab.title}{!tab.running && <span className="term-tab-exit">{t("exited", { code: tab.exitCode === null ? "" : ` ${tab.exitCode}` })}</span>}</span>
						</button>
					)}
					<button type="button" className="term-tab-close" title={t("closeTerminal")} aria-label={`${t("closeTerminal")} · ${tab.title}`} onClick={() => closeTab(tab.id)}><FiX /></button>
				</div>
			))}
			{chat.terminals.length > 3 && <button type="button" className="term-list-toggle" aria-expanded={showAllTerminals} onClick={() => setShowAllTerminals(value => !value)}>{showAllTerminals ? t("terminalShowLess") : t("terminalShowAll", { n: chat.terminals.length })}<FiChevronDown aria-hidden="true" /></button>}
			<button type="button" className="term-new-row panel-new" title={!workspacePathReady ? t("terminalChooseProject") : workspaceCwd ? `${t("newTerminal")} · ${workspaceCwd}` : t("newTerminal")} aria-label={t("newTerminal")} disabled={!chat.ready || !workspaceCwd || !workspacePathReady} onClick={openShell}><FiPlus /><span>{t("newTerminal")}</span></button>
		</div>
	</div>;

	return (
		<div className="terminal-view">
			{/* ---------------- left: workspace + terminals ---------------- */}
			<aside
				className={`term-side term-commands term-navigation ${sideOpen ? "open" : ""}`}
			>
				<section className="term-workspace-section" aria-label={t("terminalWorkspace")}>
					<div className="term-workspace-picker" ref={workspaceMenuRef} onKeyDown={event => {
						if (event.key === "Escape") { setWorkspaceOpen(false); return; }
						if (workspaceOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
							const buttons = Array.from(workspaceMenuRef.current?.querySelectorAll<HTMLButtonElement>(".term-workspace-menu button:not(:disabled)") ?? []);
							if (!buttons.length) return;
							event.preventDefault();
							const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
							buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
						}
					}}>
						<button type="button" className="term-workspace-trigger" aria-label={t("workspaceSelect")} aria-expanded={workspaceOpen} aria-haspopup="menu" title={selectedGroup?.name ?? t("workspaceNoneSelected")} onClick={() => setWorkspaceOpen(value => !value)}><WorkspaceBook /><span className="term-workspace-label"><small>{t("terminalWorkspace")}</small><strong>{selectedGroup?.name ?? t("workspaceNoneSelected")}</strong></span><FiChevronDown /></button>
						{workspaceOpen && <div className="term-workspace-menu" role="menu" aria-label={t("workspaceSelect")}>
							{chat.projectWorkspaces?.workspaces.map(group => <button type="button" key={group.id} role="menuitem" onClick={() => chooseWorkspace(group.id)}><WorkspaceBook /><span>{group.name}</span>{group.id === selectedWorkspace && <FiCheck />}</button>)}
							{!chat.projectWorkspaces?.workspaces.length && <p>{t("workspaceNoneYet")}</p>}
							<button type="button" role="menuitem" disabled={workspaceBusy} onClick={() => { setWorkspaceOpen(false); setNewWorkspaceName(""); setWorkspaceForm(true); }}><FiPlus /><span>{t("workspaceNew")}</span></button>
						</div>}
					</div>
					{selectedGroup && <div className="term-project-section">
						<div className="term-section-heading"><span>{t("workspaceProjects")}</span><button type="button" title={t("workspaceAddProject")} aria-label={t("workspaceAddProject")} disabled={workspaceBusy} onClick={() => { setWorkspaceError(""); setPicking(true); }}><FiFolderPlus /></button></div>
						<div className="term-project-list">
							{selectedGroup.paths.map(path => <div className="term-project-group" key={path}>
								<button type="button" className={`term-project-row ${path === workspaceCwd ? "active" : ""}`} title={path} aria-current={path === workspaceCwd ? "true" : undefined} disabled={!chat.ready || !active} onClick={() => { send({ type: "set_cwd", path, source: "ui" }); setSideOpen(false); }}><FiFolder className="tree-entry-icon tree-icon-folder" aria-hidden="true" /><span><strong>{projectName(path)}</strong><small>{projectPathHint(path)}</small></span>{path === workspaceCwd && <span className="term-project-total" aria-label={t("terminalCount", { n: chat.terminals.length })}>{chat.terminals.length}</span>}</button>
								{path === workspaceCwd && terminalList}
							</div>)}
							{!selectedGroup.paths.length && <p className="term-project-empty">{t("workspaceEmpty")}</p>}
						</div>
						{workspaceCwd && !selectedGroup.paths.includes(workspaceCwd) && <p className="term-project-outside">{t("workspaceOutside")}</p>}
					</div>}
					{workspaceError && !workspaceForm && !picking && <p className="term-workspace-error" role="alert">{workspaceError}</p>}
				</section>
				{!workspacePathReady || !selectedGroup ? terminalList : null}

			</aside>

			{/* ---------------- right: terminals ---------------- */}
			<div className="term-main">
				{sideOpen && (
					<div className="drawer-backdrop" onClick={() => setSideOpen(false)} />
				)}
				<button
					type="button"
					className="term-side-toggle"
					title={t("terminal")}
					onClick={() => setSideOpen((v) => !v)}
				>
					<FiMenu />
				</button>
				{chat.terminals.length === 0 ? (
					<div className="term-empty">
						<FiTerminal className="term-empty-icon" />
						<div className="term-empty-title">{t("builtinTerminal")}</div>
						<div className="term-empty-sub">{t("termEmptySub")}</div>
					</div>
				) : (
					chat.terminals.map((t) => (
						<TermXterm
							key={`${t.conversationId}:${t.id}`}
							conversationId={t.conversationId}
							terminalId={t.id}
							cols={t.cols}
							rows={t.rows}
							command={t.command}
							cwd={t.cwd}
							active={active && t.id === activeId}
							send={send}
							register={terminal.register}
						/>
					))
				)}
			</div>
			{workspaceForm && <div className="wiki-modal-backdrop"><form ref={workspaceDialogRef} className="wiki-confirm workspace-name-dialog" role="dialog" aria-modal="true" aria-label={t("workspaceNew")} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setWorkspaceForm(false); } }} onSubmit={event => { event.preventDefault(); changeWorkspace({ kind: "create", name: newWorkspaceName.trim() }); }}>
				<h2>{t("workspaceNew")}</h2>
				<label className="workspace-name-field"><span>{t("workspaceName")}</span><input autoFocus value={newWorkspaceName} maxLength={80} placeholder={t("workspaceNameExample")} onChange={event => setNewWorkspaceName(event.target.value)} /></label>
				{workspaceError && <p role="alert">{workspaceError}</p>}
				<div className="workspace-name-actions"><button type="button" onClick={() => setWorkspaceForm(false)}>{t("cancel")}</button><button disabled={workspaceBusy || !newWorkspaceName.trim()}>{t("workspaceCreate")}</button></div>
			</form></div>}
			{picking && selectedGroup && <FolderPickerModal dirBrowse={chat.dirBrowse} initialPath={workspaceCwd || selectedGroup.paths[0]} busy={workspaceBusy} error={workspaceError} pickLabel={t("workspaceAddProject")} onBrowse={path => send({ type: "browse_dirs", path })} onPick={path => changeWorkspace({ kind: "add", id: selectedGroup.id, path }, path)} onClose={() => setPicking(false)} />}
		</div>
	);
}
