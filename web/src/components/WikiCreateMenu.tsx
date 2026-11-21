import { useEffect, useId, useRef, useState } from "react";
import { FiFileText, FiFolder, FiPlus } from "react-icons/fi";
import { useT } from "../i18n";

export function WikiCreateMenu({ disabled, folderName, onChoose }: {
	disabled: boolean;
	folderName?: string;
	onChoose: (kind: "markdown" | "directory") => void;
}) {
	const t = useT(), id = useId();
	const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (root.current?.contains(document.activeElement)) trigger.current?.focus();
			setOpen(false);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escape);
		};
	}, [open]);
	const [above, setAbove] = useState(false);
	const show = () => {
		const tree = root.current?.closest(".wiki-tree");
		if (tree && root.current) {
			const bounds = tree.getBoundingClientRect(), anchor = root.current.getBoundingClientRect();
			const below = bounds.bottom - anchor.bottom;
			setAbove(below < 110 && anchor.top - bounds.top > below);
		}
		setOpen(true);
	};
	const choices = [
		{ kind: "markdown", label: "Markdown", suffix: ".md", Icon: FiFileText, color: "document" },
		{ kind: "directory", label: t("wikiFolder"), suffix: "", Icon: FiFolder, color: "folder" },
	] as const;
	return <div className="wiki-tree-new" ref={root}
		onPointerEnter={e => { if (!disabled && e.pointerType === "mouse") show(); }}
		onPointerLeave={e => { if (e.pointerType === "mouse" && !root.current?.querySelector(".wiki-new-list :focus")) setOpen(false); }}
		onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
		<button type="button" ref={trigger} className={folderName ? "wiki-create-in-folder" : undefined}
			aria-label={folderName ? `${t("wikiNewEntry")} · ${folderName}` : undefined} disabled={disabled} aria-expanded={open && !disabled} aria-controls={id}
			onClick={e => { if (!open || (e.detail && e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === "mouse")) show(); else setOpen(false); }}>
			<FiPlus aria-hidden="true" />{!folderName && t("wikiNewEntry")}
		</button>
		{open && !disabled && <div id={id} className="wiki-new-list" data-above={above || undefined} role="group" aria-label={t("wikiNewEntry")}>
			{choices.map(({ kind, label, suffix, Icon, color }) => <button type="button" key={kind} onClick={() => { setOpen(false); onChoose(kind); }}>
				<Icon className={`tree-entry-icon tree-icon-${color}`} aria-hidden="true" /><span>{label}</span>{suffix && <small>{suffix}</small>}
			</button>)}
		</div>}
	</div>;
}
