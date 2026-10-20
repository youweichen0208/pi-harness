import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FiBookOpen, FiCheck, FiChevronDown, FiChevronUp, FiPlus } from "react-icons/fi";
import type { ProjectWorkspaceCatalog } from "../types";
import { useT } from "../i18n";

type Workspace = ProjectWorkspaceCatalog["workspaces"][number];

/** First character of the name, used as the workspace avatar. */
function initial(name: string): string {
	return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

/** Stable swatch per workspace id, so reordering or renaming never recolors it. */
function swatch(id: string): number {
	let hash = 0;
	for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	return Math.abs(hash) % 3;
}

function Avatar({ workspace, size }: { workspace: Workspace; size?: "sm" }) {
	return <span className={`workspace-avatar swatch-${swatch(workspace.id)}${size ? ` ${size}` : ""}`} aria-hidden="true">{initial(workspace.name)}</span>;
}

/** Sidebar workspace switcher (design 2a–2c): a custom popover instead of a
 *  native select, so the empty state can create a workspace in place. */
export function WorkspaceSwitcher({ workspaces, selected, disabled, busy, name, onName, onChoose, onCreate, onManage, onAddProject }: {
	workspaces: Workspace[];
	selected: Workspace | undefined;
	/** Catalog not loaded or an action is pending: switching is unavailable. */
	disabled: boolean;
	/** Creating is unavailable (also covers disconnection). */
	busy: boolean;
	/** Name draft, shared with the first-start checklist. */
	name: string;
	onName: (name: string) => void;
	onChoose: (id: string) => void;
	onCreate: (name: string) => void;
	onManage: () => void;
	onAddProject: () => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const empty = workspaces.length === 0;
	const showForm = empty || creating;

	useEffect(() => {
		if (!open) { setCreating(false); return; }
		const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);
	// A new selection (including the one made after creating) closes the menu.
	useEffect(() => { setOpen(false); }, [selected?.id]);
	// Focus the first item, or the name input when the form is shown.
	useEffect(() => {
		if (open) menuRef.current?.querySelector<HTMLElement>("input, [role^=menuitem]:not(:disabled)")?.focus();
	}, [open, showForm]);

	const close = () => { setOpen(false); triggerRef.current?.focus(); };
	const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			if (creating && !empty) setCreating(false); else close();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? []);
		if (!items.length) return;
		event.preventDefault();
		const at = items.indexOf(document.activeElement as HTMLElement);
		items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
	};

	return <div className="workspace-switcher" ref={rootRef}>
		<button
			ref={triggerRef}
			type="button"
			className={`workspace-switcher-trigger${selected ? "" : " empty"}${open ? " open" : ""}`}
			aria-haspopup="menu"
			aria-expanded={open}
			aria-label={t("workspaceSelect")}
			disabled={disabled}
			onClick={() => setOpen((value) => !value)}
			onKeyDown={(event) => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); } }}
		>
			<span className="workspace-book" aria-hidden="true"><FiBookOpen /></span>
			<span className="workspace-switcher-name" title={selected?.name}>{selected?.name ?? t("workspaceNoneSelected")}</span>
			{open ? <FiChevronUp aria-hidden="true" /> : <FiChevronDown aria-hidden="true" />}
		</button>
		<button type="button" className="workspace-add" title={t(selected ? "workspaceAddProject" : "workspaceNew")} aria-label={t(selected ? "workspaceAddProject" : "workspaceNew")} disabled={busy} onClick={() => {
			if (selected) { setOpen(false); onAddProject(); }
			else { setCreating(true); setOpen(true); }
		}}><FiPlus /></button>
		{open && <div className="workspace-switcher-menu" role="menu" aria-label={t("workspaceSelect")} ref={menuRef} onKeyDown={onMenuKeyDown}>
			{showForm ? <form className="workspace-switcher-create" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate(name); }}>
				{empty && <p>{t("workspaceNoneYet")}</p>}
				<input aria-label={t("workspaceName")} placeholder={t("workspaceName")} value={name} maxLength={80} disabled={busy} onChange={(event) => onName(event.target.value)} />
				<button type="submit" disabled={busy || !name.trim()}>{t("workspaceCreate")}</button>
			</form> : <>
				{workspaces.map((workspace) => {
					const current = workspace.id === selected?.id;
					return <button key={workspace.id} type="button" role="menuitemradio" aria-checked={current} className={`workspace-switcher-item${current ? " current" : ""}`} disabled={disabled} onClick={() => { if (current) close(); else onChoose(workspace.id); }}>
						<Avatar workspace={workspace} size="sm" />
						<span className="workspace-switcher-name">{workspace.name}</span>
						{current ? <FiCheck className="workspace-switcher-check" aria-hidden="true" /> : <span className="workspace-switcher-count" title={t("workspaceProjectCount", { n: workspace.paths.length })}>{workspace.paths.length}</span>}
					</button>;
				})}
				<div className="workspace-switcher-divider" role="separator" />
				<button type="button" role="menuitem" className="workspace-switcher-action accent" disabled={busy} onClick={() => setCreating(true)}><FiPlus aria-hidden="true" />{t("workspaceNew")}</button>
				<button type="button" role="menuitem" className="workspace-switcher-action" onClick={() => { onManage(); close(); }}><span aria-hidden="true" />{t("workspaceManageMenu")}</button>
			</>}
		</div>}
	</div>;
}
