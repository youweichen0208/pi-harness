import { useEffect, useRef, type ReactNode } from "react";
import { FiChevronDown } from "react-icons/fi";

interface DropdownProps {
	keyboardNavigation?: boolean;
	/** The clickable trigger (chip/button). */
	trigger: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
	/** Align the menu edge with the trigger's edge (default right, since the
	 * toolbar sits at the top-right of the window). */
	align?: "left" | "right";
	/** Let the menu grow to fit its content instead of capping at the default
	 * max-height with a scrollbar (e.g. small fixed panels like the update
	 * dropdown). */
	fit?: boolean;
	/** Which side of the trigger the menu opens on. "down" (default) drops below;
	 * "up" floats above it — for bottom-anchored bars (e.g. the goal bar) where
	 * dropping down would overflow the viewport. */
	direction?: "down" | "up";
	/** Extra class(es) for the .dd-menu panel itself (e.g. "dd-menu-model"
	 * makes only the inner scroll band scroll, keeping header/footer fixed). */
	menuClassName?: string;
}

/** Click-outside-aware dropdown menu. */
export function Dropdown({
	trigger,
	open,
	onOpenChange,
	children,
	align = "right",
	fit = false,
	direction = "down",
	menuClassName,
	keyboardNavigation = false,
}: DropdownProps) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const owner = ref.current?.ownerDocument ?? document;
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onOpenChange(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); onOpenChange(false); if (keyboardNavigation) ref.current?.querySelector<HTMLButtonElement>(":scope > button")?.focus(); }
		};
		owner.addEventListener("mousedown", onDown);
		owner.addEventListener("keydown", onKey);
		return () => {
			owner.removeEventListener("mousedown", onDown);
			owner.removeEventListener("keydown", onKey);
		};
	}, [open, onOpenChange, keyboardNavigation]);

	useEffect(() => {
		if (open && keyboardNavigation) ref.current?.querySelector<HTMLButtonElement>(".dd-item:not(:disabled)")?.focus();
	}, [open, keyboardNavigation]);

	return (
		<div
			className={`dropdown ${align} ${fit ? "fit" : ""} ${direction === "up" ? "dd-up" : ""}`}
			ref={ref}
			onKeyDown={event => {
				if (!keyboardNavigation || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				if (!open) { onOpenChange(true); return; }
				const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(".dd-item:not(:disabled)") ?? []);
				const index = items.indexOf(document.activeElement as HTMLButtonElement);
				const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
				items[next]?.focus();
			}}
		>
			<button
				type="button"
				className="chip"
				onClick={() => onOpenChange(!open)}
				aria-expanded={open}
			>
				{trigger}
				<FiChevronDown className={`dd-caret ${open ? "up" : ""}`} />
			</button>
			{open && <div className={`dd-menu ${menuClassName ?? ""}`}>{children}</div>}
		</div>
	);
}

export function DropdownItem({
	active,
	disabled = false,
	title,
	onClick,
	children,
}: {
	active?: boolean;
	disabled?: boolean;
	/** Tooltip shown when the item is disabled (e.g. why a level is off-limits). */
	title?: string;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className={`dd-item ${active ? "active" : ""}`}
			aria-current={active ? "page" : undefined}
			disabled={disabled}
			title={title}
			onClick={onClick}
		>
			{children}
		</button>
	);
}
