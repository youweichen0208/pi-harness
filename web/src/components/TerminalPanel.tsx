import { useEffect, useRef, useState } from "react";
import { randomUuid } from "../uuid";
import {
	FiCheck,
	FiChevronDown,
	FiEdit2,
	FiFolder,
	FiFolderPlus,
	FiMenu,
	FiPlay,
	FiPlus,
	FiRefreshCw,
	FiTerminal,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { ClientMessage, CommandDef, ProjectWorkspaceAction } from "../types";
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

interface Draft {
	name: string;
	command: string;
	cwd: string;
}

const EMPTY_DRAFT: Draft = { name: "", command: "", cwd: "${pwd}" };

/**
 * Inline rename field for a terminal tab (double-click or F2 on the tab).
 * Mirrors the knowledge-base document rename row (`wiki-history-row form`):
 * a bordered input followed by plain 保存 / 取消 buttons — not an icon-only
 * control and not the browser's default focus ring. Owns its draft text so the
 * parent only tracks WHICH tab is being renamed; Enter/保存 commits, Esc/取消
 * cancels, an emptied field cancels instead of leaving a nameless tab.
 */
function TabRenameInput({ value, label, saveLabel, cancelLabel, onSubmit, onCancel }: { value: string; label: string; saveLabel: string; cancelLabel: string; onSubmit: (next: string) => void; onCancel: () => void }) {
	const [text, setText] = useState(value);
	const inputRef = useRef<HTMLInputElement>(null);
	// Focus + select explicitly: the tab strip re-renders whenever terminal_list
	// arrives, and autoFocus alone does not reliably keep the caret in the field.
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	const finish = (commit: boolean) => {
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
				placeholder={label}
				onChange={(event) => setText(event.target.value)}
				onFocus={(event) => event.currentTarget.select()}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						finish(false);
					}
				}}
			/>
			<button type="submit" className="term-tab-rename-save" title={saveLabel} disabled={!text.trim()}>{saveLabel}</button>
			<button type="button" title={cancelLabel} onClick={() => finish(false)}>{cancelLabel}</button>
		</form>
	);
}

/**
 * Built-in terminal — two panes:
 *   left : active project directory + terminal tabs + user command list
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
	/** Terminal tab currently in inline-rename mode. */
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const focusedRequest = useRef<typeof focusRequest>();

	// Mobile: the left column (commands + tabs) slides in as a drawer.
	const [sideOpen, setSideOpen] = useState(false);
	// Command list editing state.
	const [isNew, setIsNew] = useState(false);
	const [editingIdx, setEditingIdx] = useState<number | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	// Two-step delete confirmation.
	const [confirmDel, setConfirmDel] = useState<number | null>(null);
	const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

	useEffect(() => {
		return () => {
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		};
	}, []);

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

	const runCommand = (cmd: CommandDef) => {
		if (!workspacePathReady) return;
		const title = cmd.name || cmd.command;
		// Reuse a terminal with the same title (VSCode-style task reuse): the
		// command is re-run in the SAME tab — a running process is interrupted
		// first (the server kills the PTY's process group and starts fresh).
		const existing = chat.terminals.find((t) => t.title === title);
		if (existing) {
			terminal.restart(existing.id);
			setActiveId(existing.id);
			send({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
			return;
		}
		openTab({ title, cwd: chat.state?.cwd ?? "", command: cmd });
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

	// -- command list editing --------------------------------------------------

	const startNew = () => {
		setIsNew(true);
		setEditingIdx(null);
		setDraft(EMPTY_DRAFT);
	};

	const startEdit = (idx: number) => {
		const c = chat.commands[idx];
		if (!c) return;
		setIsNew(false);
		setEditingIdx(idx);
		setDraft({ name: c.name, command: c.command, cwd: c.cwd ?? "" });
	};

	const cancelEdit = () => {
		setIsNew(false);
		setEditingIdx(null);
	};

	const saveDraft = () => {
		const name = draft.name.trim();
		const command = draft.command.trim();
		if (!name || !command) return;
		const cwd = draft.cwd.trim();
		const def: CommandDef = { name, command, cwd: cwd ? cwd : undefined };
		const next = isNew
			? [...chat.commands, def]
			: editingIdx !== null
				? chat.commands.map((c, i) => (i === editingIdx ? def : c))
				: chat.commands;
		send({ type: "save_commands", commands: next });
		cancelEdit();
	};

	const requestDelete = (idx: number) => {
		if (confirmDel === idx) {
			const next = chat.commands.filter((_, i) => i !== idx);
			send({ type: "save_commands", commands: next });
			setConfirmDel(null);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		} else {
			setConfirmDel(idx);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
			confirmTimer.current = setTimeout(() => setConfirmDel(null), 2500);
		}
	};

	const editing = isNew || editingIdx !== null;
	const terminalList = <div className="term-tabs-block" role="group" aria-label={t("builtinTerminal")}>
		<div className="panel-body">
			{chat.terminals.map((tab) => (
				<div key={tab.id} className={`term-tab ${tab.id === activeId ? "active" : ""} ${renamingId === tab.id ? "renaming" : ""}`}>
					{renamingId === tab.id ? (
						<>
							{/* Keep the run/exit dot visible while renaming: it is the only
							    status cue on the row (green = live PTY). */}
							<span className={`term-tab-dot ${tab.running ? "run" : "exit"}`} title={tab.running ? undefined : t("exited", { code: tab.exitCode === null ? "" : ` ${tab.exitCode}` })} />
							<TabRenameInput
								value={tab.title}
								label={t("terminalRename")}
								saveLabel={t("save")}
								cancelLabel={t("cancel")}
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
							<span className={`term-tab-dot ${tab.running ? "run" : "exit"}`} />
							<span className="term-tab-title">{tab.title}{!tab.running && <span className="term-tab-exit">{t("exited", { code: tab.exitCode === null ? "" : ` ${tab.exitCode}` })}</span>}</span>
						</button>
					)}
					<button type="button" className="term-tab-close" title={t("closeTerminal")} aria-label={`${t("closeTerminal")} · ${tab.title}`} onClick={() => closeTab(tab.id)}><FiX /></button>
				</div>
			))}
			<button type="button" className="term-new-row panel-new" title={!workspacePathReady ? t("terminalChooseProject") : workspaceCwd ? `${t("newTerminal")} · ${workspaceCwd}` : t("newTerminal")} aria-label={t("newTerminal")} disabled={!chat.ready || !workspaceCwd || !workspacePathReady} onClick={openShell}><FiPlus /><span>{t("newTerminal")}</span></button>
		</div>
	</div>;

	return (
		<div className="terminal-view">
			{/* ---------------- left: workspace + terminals + commands ---------------- */}
			<aside
				className={`term-side term-commands ${chat.commands.length === 0 && !editing ? "commands-empty" : ""} ${editing ? "editing-command" : ""} ${sideOpen ? "open" : ""}`}
			>
				<section className="term-workspace-section" aria-label={t("terminalWorkspace")}>
					<div className="term-section-heading"><span>{t("terminalWorkspace")}</span></div>
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
						<button type="button" className="term-workspace-trigger" aria-label={t("workspaceSelect")} aria-expanded={workspaceOpen} aria-haspopup="menu" title={selectedGroup?.name ?? t("workspaceNoneSelected")} onClick={() => setWorkspaceOpen(value => !value)}><WorkspaceBook /><span>{selectedGroup?.name ?? t("workspaceNoneSelected")}</span><FiChevronDown /></button>
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
								<button type="button" className={`term-project-row ${path === workspaceCwd ? "active" : ""}`} title={path} aria-current={path === workspaceCwd ? "true" : undefined} disabled={!chat.ready || !active} onClick={() => { send({ type: "set_cwd", path, source: "ui" }); setSideOpen(false); }}><FiFolder className="tree-entry-icon tree-icon-folder" aria-hidden="true" /><span><strong>{projectName(path)}</strong><small>{projectPathHint(path)}</small></span></button>
								{path === workspaceCwd && terminalList}
							</div>)}
							{!selectedGroup.paths.length && <p className="term-project-empty">{t("workspaceEmpty")}</p>}
						</div>
						{workspaceCwd && !selectedGroup.paths.includes(workspaceCwd) && <p className="term-project-outside">{t("workspaceOutside")}</p>}
					</div>}
					{workspaceError && !workspaceForm && !picking && <p className="term-workspace-error" role="alert">{workspaceError}</p>}
				</section>
				{!workspacePathReady || !selectedGroup ? terminalList : null}
				<div className="term-command-section">
					<div className="panel-header">
						<span className="panel-title">{t("commands")}</span>
						<div className="panel-header-actions">
							<button
								type="button"
								className="panel-refresh"
								title={t("rerun")}
								onClick={() => send({ type: "list_commands" })}
							>
								<FiRefreshCw />
							</button>
							<button
								type="button"
								className="panel-new"
								title={t("newCommand")}
								onClick={startNew}
							>
								<FiPlus />
							</button>
						</div>
					</div>

					<div className="panel-body">
						{editing ? (
							<div className="cmd-form">
								<label htmlFor="cmd-name">{t("name")}</label>
								<input
									id="cmd-name"
									className="cmd-input"
									value={draft.name}
									placeholder={t("exampleName")}
									autoFocus
									onChange={(e) => setDraft({ ...draft, name: e.target.value })}
								/>
								<label htmlFor="cmd-command">{t("command")}</label>
								<input
									id="cmd-command"
									className="cmd-input"
									value={draft.command}
									placeholder={t("exampleCommand")}
									onChange={(e) =>
										setDraft({ ...draft, command: e.target.value })
									}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.nativeEvent.isComposing) {
											saveDraft();
										}
									}}
								/>
								<label htmlFor="cmd-cwd">
									{t("directory")}{" "}
									<span className="cmd-hint">{t("cwdHint")}</span>
								</label>
								<input
									id="cmd-cwd"
									className="cmd-input"
									value={draft.cwd}
									placeholder="${pwd}"
									onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.nativeEvent.isComposing) {
											saveDraft();
										}
									}}
								/>
								<div className="cmd-form-actions">
									<button type="button" className="btn" onClick={cancelEdit}>
										{t("cancel")}
									</button>
									<button
										type="button"
										className="btn primary"
										disabled={!draft.name.trim() || !draft.command.trim()}
										onClick={saveDraft}
									>
										{t("save")}
									</button>
								</div>
							</div>
						) : (
							<>
								{chat.commands.length === 0 && (
									<div className="panel-empty">{t("noCommands")}</div>
								)}
								{chat.commands.map((c, i) => (
									<div key={i} className="cmd-item">
										<button
											type="button"
											className="cmd-run"
									title={workspacePathReady ? t("clickToRun") : t("terminalChooseProject")}
									disabled={!workspacePathReady}
											onClick={() => runCommand(c)}
										>
											<FiPlay />
										</button>
										<button
											type="button"
											className="cmd-main"
									title={workspacePathReady ? t("clickToRun") : t("terminalChooseProject")}
									disabled={!workspacePathReady}
											onClick={() => runCommand(c)}
										>
											<span className="cmd-name">{c.name}</span>
											<span className="cmd-command">{c.command}</span>
											{c.cwd && <span className="cmd-cwd">{c.cwd}</span>}
										</button>
										<button
											type="button"
											className="cmd-act"
											title={t("edit")}
											onClick={() => startEdit(i)}
										>
											<FiEdit2 />
										</button>
										<button
											type="button"
											className={`cmd-act del ${confirmDel === i ? "confirm" : ""}`}
											title={t("delete")}
											onClick={() => requestDelete(i)}
										>
											{confirmDel === i ? t("confirmQ") : <FiTrash2 />}
										</button>
									</div>
								))}
							</>
						)}
					</div>

				</div>
			</aside>

			{/* ---------------- right: terminals ---------------- */}
			<div className="term-main">
				{sideOpen && (
					<div className="drawer-backdrop" onClick={() => setSideOpen(false)} />
				)}
				<button
					type="button"
					className="term-side-toggle"
					title={t("commands")}
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
