import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Move a stable portal container so messages, composer and drafts never remount. */
export function ChatDock({ target, children, className = "" }: { target: HTMLElement | null; children: ReactNode; className?: string }) {
	const home = useRef<HTMLDivElement>(null);
	const homeScroll = useRef(0);
	const docked = useRef(false);
	const [container] = useState(() => {
		const element = document.createElement("main");
		element.className = "main";
		return element;
	});
	useLayoutEffect(() => { container.className = `main ${className}`; }, [container, className]);
	useLayoutEffect(() => {
		const scroll = container.querySelector<HTMLElement>(".messages");
		if (target && !docked.current) homeScroll.current = scroll?.scrollTop ?? 0;
		const top = target ? scroll?.scrollTop ?? 0 : homeScroll.current;
		(target ?? home.current)?.appendChild(container);
		if (scroll) scroll.scrollTop = top;
		docked.current = !!target;
	}, [container, target]);
	useLayoutEffect(() => () => { container.remove(); }, [container]);
	return <><div className="main chat-home" ref={home} />{createPortal(children, container)}</>;
}
