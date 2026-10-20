import { desktopAPI } from "../desktop";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** One React portal and DOM tree, moved between Wiki and its native blank window. */
export function WikiAssistantWindow({ detached, onClose, children }: { detached: boolean; onClose: () => void; children: ReactNode }) {
	const home = useRef<HTMLDivElement>(null);
	const popupRef = useRef<Window | null>(null);
	const close = useRef(onClose);
	close.current = onClose;
	const [container] = useState(() => document.createElement("div"));
	useLayoutEffect(() => {
		container.className = "wiki-assistant-container";
		home.current?.appendChild(container);
		if (!detached) return;
		const popup = popupRef.current && !popupRef.current.closed ? popupRef.current : window.open("about:blank", "pi-wiki-assistant", "width=375,height=820");
		popupRef.current = popup;
		if (!popup) return; // Keep the in-page assistant usable if opening failed.
		const target = popup.document;
		target.title = "问 pi · pi";
		target.head.replaceChildren();
		const base = target.createElement("base");
		base.href = document.baseURI;
		target.head.appendChild(base);
		for (const style of document.querySelectorAll('link[rel="stylesheet"], style')) target.head.appendChild(style.cloneNode(true));
		const syncTheme = () => {
			for (const attr of [...target.documentElement.attributes]) target.documentElement.removeAttribute(attr.name);
			for (const attr of [...document.documentElement.attributes]) target.documentElement.setAttribute(attr.name, attr.value);
		};
		syncTheme();
		const observer = new MutationObserver(syncTheme);
		observer.observe(document.documentElement, { attributes: true });
		target.body.className = "wiki-assistant-desktop design-workspace";
		target.body.appendChild(container);
		const restore = () => { home.current?.appendChild(container); close.current(); };
		popup.addEventListener("beforeunload", restore);
		const closed = window.setInterval(() => { if (popup.closed) { window.clearInterval(closed); restore(); } }, 250);
		void desktopAPI?.assistantVisibility?.(true);
		popup.focus();
		const stop = desktopAPI?.onAssistantHidden?.(restore);
		return () => {
			stop?.();
			observer.disconnect();
			window.clearInterval(closed);
			popup.removeEventListener("beforeunload", restore);
			home.current?.appendChild(container);
			void desktopAPI?.assistantVisibility?.(false);
		};
	}, [detached, container]);
	useLayoutEffect(() => () => { container.remove(); }, [container]);
	return <><div className="wiki-assistant-home" ref={home} />{createPortal(children, container)}</>;
}
