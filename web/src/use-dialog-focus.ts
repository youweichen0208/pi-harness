import { useLayoutEffect, useRef } from "react";

const dialogs: HTMLElement[] = [];
export const isTopDialog = (root: HTMLElement | null) => !!root && dialogs.findLast(dialog => dialog.ownerDocument === root.ownerDocument) === root;
const focusable = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Keep keyboard traversal in the topmost dialog and restore its opener. */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(active = true, owner: Document = document) {
	const ref = useRef<T>(null);
	const focused = () => owner.activeElement && "focus" in owner.activeElement ? owner.activeElement as HTMLElement : null;
	const openerRef = useRef(focused());
	const menuTriggerRef = useRef(openerRef.current?.closest(".dropdown")?.querySelector<HTMLElement>(":scope > button") ?? null);
	const previouslyActive = useRef(false);
	if (active && !previouslyActive.current) {
		openerRef.current = focused();
		menuTriggerRef.current = openerRef.current?.closest(".dropdown")?.querySelector<HTMLElement>(":scope > button") ?? null;
	}
	previouslyActive.current = active;
	useLayoutEffect(() => {
		const root = ref.current;
		if (!active || !root) return;
		const opener = openerRef.current;
		dialogs.push(root);
		const controls = () => Array.from(root.querySelectorAll<HTMLElement>(focusable)).filter(element =>
			!element.matches(':disabled, [aria-disabled="true"]') && !element.closest('[inert]') && element.getClientRects().length > 0 && owner.defaultView?.getComputedStyle(element).visibility !== "hidden",
		);
		if (isTopDialog(root) && !root.contains(owner.activeElement)) (controls()[0] ?? root).focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || !isTopDialog(root)) return;
			const items = controls();
			const current = owner.activeElement;
			if (!items.length) { event.preventDefault(); root.focus(); return; }
			if (!root.contains(current) || event.shiftKey && current === items[0] || !event.shiftKey && current === items.at(-1)) {
				event.preventDefault();
				(event.shiftKey ? items.at(-1)! : items[0]).focus();
			}
		};
		owner.addEventListener("keydown", onKey, true);
		return () => {
			owner.removeEventListener("keydown", onKey, true);
			const topmost = isTopDialog(root);
			const index = dialogs.indexOf(root);
			if (index !== -1) dialogs.splice(index, 1);
			const restore = opener?.isConnected ? opener : menuTriggerRef.current;
			if (topmost && restore?.isConnected) restore.focus({ preventScroll: true });
		};
	}, [active, owner]);
	return ref;
}
