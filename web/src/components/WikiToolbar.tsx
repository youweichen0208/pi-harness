import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Icon from "react-icons/lu";
import type { RichCommands, RichCommand } from "../rich-commands";
import { useT } from "../i18n";
export interface WikiInsertItem { id: string; label: string; hint: string; help: string; icon: ReactNode }
export interface WikiInsertPopup { kind: "table" | "code"; x: number; y: number }
export function WikiInsertPopover({ popup, onClose, children }: { popup: WikiInsertPopup; onClose: () => void; children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.left = `${Math.max(8, Math.min(popup.x, innerWidth - el.offsetWidth - 8))}px`;
		el.style.top = `${Math.max(8, Math.min(popup.y, innerHeight - el.offsetHeight - 8))}px`;
		el.querySelector<HTMLElement>('input, [tabindex="0"], button')?.focus();
	}, [popup]);
	useEffect(() => {
		const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
		window.addEventListener("pointerdown", outside); window.addEventListener("resize", onClose);
		return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("resize", onClose); };
	}, [onClose]);
	return createPortal(<div ref={ref} className={`wiki-insert-popover wiki-${popup.kind}-popover`} role="dialog" onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }} style={{ left: popup.x, top: popup.y }}>{children}</div>, document.querySelector(".wiki-document-dialog") ?? document.body);
}
type Action = { label: string; icon?: ReactNode; command?: RichCommand; value?: string; id?: string; options?: Action[] };
export function WikiToolbar({ readOnly, focused, onWidth, items, commands, editor }: {
	readOnly: boolean; focused: boolean; onWidth: () => void; items: WikiInsertItem[];
	commands: RichCommands; editor: HTMLElement | null;
}) {
	const t = useT(), bar = useRef<HTMLDivElement>(null), menuRef = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement | null>(null);
	const [count, setCount] = useState(0), [menu, setMenu] = useState<Action[] | null>(null);
	const [state, setState] = useState<Record<string, string | boolean>>({});
	const a = (command: RichCommand, icon: ReactNode, value?: string): Action => ({ label: t(commands.describe(command).label), icon, command, value });
	const choices = (key: Parameters<typeof t>[0], icon: ReactNode, options: Action[]): Action => ({ label: t(key), icon, options });
	const select = (command: RichCommand, icon: ReactNode): Action => ({
		label: t(commands.describe(command).label), icon,
		options: commands.describe(command).options?.map(option => ({ label: option.label ? t(option.label) + (option.suffix ?? "") : option.text ?? option.value, command, value: option.value })),
	});
	const insert = (id: string): Action => { const item = items.find(item => item.id === id); return { label: item?.label ?? id, icon: item?.icon, id }; };
	const groups: Action[][] = [
		[a("undo", <Icon.LuUndo2 />), a("redo", <Icon.LuRedo2 />)],
		[select("formatBlock", <span>{state.block === "p" ? t("richParagraph") : state.block || "—"}</span>), select("font-size", <span>{state.size || "—"}</span>)],
		[a("bold", <Icon.LuBold />), a("italic", <Icon.LuItalic />), a("strikeThrough", <Icon.LuStrikethrough />), a("underline", <Icon.LuUnderline />)],
		[select("color", <Icon.LuBaseline />), select("highlight", <Icon.LuHighlighter />)],
		[select("text-align", <Icon.LuAlignLeft />), a("insertUnorderedList", <Icon.LuList />), a("insertOrderedList", <Icon.LuListOrdered />), a("outdent", <Icon.LuIndentDecrease />), a("indent", <Icon.LuIndentIncrease />), select("line-height", <Icon.LuChevronsUpDown />)],
		[a("task", <Icon.LuSquareCheck />), { ...insert("link"), icon: <Icon.LuLink /> }, { ...insert("yy"), icon: <Icon.LuTextQuote /> }, { ...insert("fgx"), icon: <Icon.LuMinus /> }],
	];
	const close = () => { setMenu(null); trigger.current?.focus({ preventScroll: true }); };
	useLayoutEffect(() => {
		const el = bar.current; if (!el) return;
		const resize = () => {
			const widths = [...el.querySelectorAll<HTMLElement>(".wiki-toolbar-measure > div")].map(group => group.offsetWidth);
			let used = 104, visible = 0;
			for (const width of widths) { if (used + width > el.clientWidth) break; used += width; visible++; }
			setCount(visible);
		};
		const observer = new ResizeObserver(resize); observer.observe(el); resize(); return () => observer.disconnect();
	}, [state.block, state.size]);
	useEffect(() => {
		const changed = () => {
			const selection = getSelection(); if (!editor || !selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return;
			const range = selection.getRangeAt(0), nodes: Element[] = [];
			if (range.collapsed) { const node = selection.anchorNode; if (node) nodes.push(node instanceof Element ? node : node.parentElement!); }
			else { const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let node; while ((node = walker.nextNode())) if (node.textContent?.trim() && range.intersectsNode(node)) nodes.push(node.parentElement!); }
			const uniform = (get: (el: Element) => string) => { const values = new Set(nodes.map(get)); return values.size === 1 ? [...values][0] : ""; };
			setState({ block: uniform(el => el.closest("p,h1,h2,h3,h4,h5,h6,li,blockquote")?.tagName.toLowerCase() ?? "p"), size: uniform(el => getComputedStyle(el).fontSize.replace("px", "")), ...Object.fromEntries(["bold","italic","underline","strikeThrough","insertUnorderedList","insertOrderedList"].map(key => [key, !document.queryCommandIndeterm(key) && document.queryCommandState(key)])) });
		};
		document.addEventListener("selectionchange", changed); editor?.addEventListener("input", changed); return () => { document.removeEventListener("selectionchange", changed); editor?.removeEventListener("input", changed); };
	}, [editor]);
	useLayoutEffect(() => {
		if (!menu || !menuRef.current || !trigger.current) return;
		const el = menuRef.current, rect = trigger.current.getBoundingClientRect();
		el.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - el.offsetWidth - 8))}px`;
		el.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - el.offsetHeight - 8))}px`;
		el.querySelector<HTMLButtonElement>("button")?.focus();
	}, [menu]);
	useEffect(() => {
		if (!menu) return;
		const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMenu(null); };
		document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
	}, [menu]);
	const execute = (action: Action) => { if (action.options) { setMenu(action.options); return; } setMenu(null); if (action.id) commands.insert(action.id); else if (action.command) commands.execute(action.command, action.value); };
	const button = (action: Action, index: number) => <button key={index} type="button" disabled={readOnly} title={action.label} aria-label={action.label} aria-haspopup={action.options ? "menu" : undefined} aria-expanded={action.options ? !!menu && trigger.current?.getAttribute("aria-label") === action.label : undefined} aria-pressed={typeof state[action.command ?? ""] === "boolean" ? !!state[action.command!] : undefined} onMouseDown={e => { e.preventDefault(); commands.prepare(); }} onClick={e => { commands.prepare(); if (action.options) { trigger.current = e.currentTarget; setMenu(action.options); } else execute(action); }}>{action.icon}</button>;
	const overflow = [...groups.slice(count).flat(), a("superscript", <Icon.LuSuperscript />), a("subscript", <Icon.LuSubscript />), a("plainBlock", <Icon.LuType />)];
	return <div ref={bar} className="wiki-insert-toolbar wiki-unified-toolbar" role="toolbar" aria-label={t("richFormatToolbar")}>
		<div className="wiki-toolbar-insert">{button(choices("richInsertMenu", <Icon.LuPlus />, ["tp","bg","dmk","glk","tip","warning","collapse","card","sl","date","ml"].map(insert)), 0)}</div>
		{groups.slice(0,count).map((group,i) => <div className="wiki-tool-group" key={i}>{group.map(button)}</div>)}
		{button(choices("richMore", <Icon.LuEllipsis />, overflow), -1)}
		<button type="button" className="wiki-width-toggle" title={t(focused ? "wikiStandardWidth" : "wikiWideWidth")} aria-label={t(focused ? "wikiStandardWidth" : "wikiWideWidth")} aria-pressed={focused} onMouseDown={e => e.preventDefault()} onClick={onWidth}><Icon.LuMoveHorizontal /></button>
		<div className="wiki-toolbar-measure" aria-hidden="true" {...{ inert: "" } as Record<string, string>}>{groups.map((group,i) => <div className="wiki-tool-group" key={i}>{group.map(button)}</div>)}</div>
		{menu && createPortal(<div ref={menuRef} className="wiki-toolbar-menu" role="menu" aria-label={t("richMore")} onKeyDown={e => {
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
			if (["ArrowDown","ArrowUp","Home","End"].includes(e.key)) { e.preventDefault(); const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")], index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length-1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
			if (e.key === "Tab") close();
		}}>{menu.map((action,i) => <button key={i} role="menuitem" type="button" disabled={readOnly} onMouseDown={e => e.preventDefault()} onClick={() => execute(action)}>{action.icon}{action.label}{action.options && <Icon.LuChevronRight />}</button>)}</div>, document.querySelector(".wiki-document-dialog") ?? document.body)}
	</div>;
}
