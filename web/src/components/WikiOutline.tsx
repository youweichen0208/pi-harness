import { useEffect, useMemo, useState, type RefObject } from "react";
import { FiChevronDown, FiChevronRight, FiEye, FiEyeOff, FiList } from "react-icons/fi";
import { useT } from "../i18n";

type Heading = { element: HTMLElement; text: string; level: number };
type OutlineNode = Heading & { children: OutlineNode[] };

/** Keep live element references: duplicate titles must navigate to different headings. */
export function WikiOutline({ scope, onNavigate }: { scope: RefObject<HTMLDivElement>; onNavigate: () => void }) {
	const t = useT();
	const [headings, setHeadings] = useState<Heading[]>([]);
	const [collapsed, setCollapsed] = useState<Set<HTMLElement>>(() => new Set());
	const [hidden, setHidden] = useState(false);
	const [active, setActive] = useState<HTMLElement | null>(null);
	useEffect(() => {
		const root = scope.current;
		if (!root) return;
		const refresh = () => {
			const next = [...root.querySelectorAll<HTMLElement>(".wiki-document-heading h1, .wiki-prose h1, .wiki-prose h2, .wiki-prose h3, .wiki-prose h4, .wiki-prose h5, .wiki-prose h6")]
				.filter(element => !element.closest("[hidden], .is-source, [data-rich-toc], [data-rich-ui], blockquote, li, table") && element.textContent?.trim())
				.map(element => ({ element, text: element.textContent!.trim(), level: element.closest(".wiki-document-heading") ? 0 : Number(element.tagName[1]) }));
			setHeadings(previous => previous.length === next.length && previous.every((entry, index) => entry.element === next[index].element && entry.text === next[index].text && entry.level === next[index].level) ? previous : next);
			setCollapsed(previous => {
				const retained = new Set([...previous].filter(element => next.some(entry => entry.element === element)));
				return retained.size === previous.size ? previous : retained;
			});
		};
		const observer = new MutationObserver(records => {
			if (records.some(record => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest(".wiki-view")
				|| [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches(".wiki-view") || node.querySelector(".wiki-view"))))) refresh();
		});
		observer.observe(root, { subtree: true, childList: true, characterData: true });
		refresh();
		return () => observer.disconnect();
	}, [scope]);
	const tree = useMemo(() => {
		const roots: OutlineNode[] = [], stack: OutlineNode[] = [];
		for (const heading of headings) {
			const node: OutlineNode = { ...heading, children: [] };
			while (stack.length && stack.at(-1)!.level >= node.level) stack.pop();
			(stack.at(-1)?.children ?? roots).push(node);
			stack.push(node);
		}
		return roots;
	}, [headings]);
	useEffect(() => {
		const root = scope.current, scroll = headings[0]?.element.closest<HTMLElement>(".wiki-scroll");
		if (!root || !scroll) { setActive(null); return; }
		let frame = 0;
		const update = () => {
			frame = 0;
			const top = scroll.getBoundingClientRect().top + 48;
			let current = headings[0]?.element ?? null;
			for (const heading of headings) {
				if (heading.element.getBoundingClientRect().top > top) break;
				current = heading.element;
			}
			if (scroll.scrollHeight > scroll.clientHeight + 1 && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) current = headings.at(-1)?.element ?? current;
			setActive(current);
		};
		const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
		const resize = new ResizeObserver(schedule);
		resize.observe(scroll);
		const document = scroll.querySelector(".wiki-document");
		if (document) resize.observe(document);
		scroll.addEventListener("scroll", schedule, { passive: true });
		update();
		return () => { cancelAnimationFrame(frame); resize.disconnect(); scroll.removeEventListener("scroll", schedule); };
	}, [scope, headings]);
	const branches: HTMLElement[] = [];
	let visibleActive = active;
	const visit = (nodes: OutlineNode[], hiddenBy: HTMLElement | null = null) => {
		for (const node of nodes) {
			if (node.children.length) branches.push(node.element);
			if (node.element === active && hiddenBy) visibleActive = hiddenBy;
			visit(node.children, hiddenBy ?? (collapsed.has(node.element) ? node.element : null));
		}
	};
	visit(tree);
	const allCollapsed = branches.length > 0 && branches.every(element => collapsed.has(element));
	const render = (nodes: OutlineNode[]) => <ul>{nodes.map((node, index) => {
		const closed = collapsed.has(node.element);
		return <li key={index}>
			<div className={`wiki-outline-row ${visibleActive === node.element ? "active" : ""}`}>
				{node.children.length ? <button className="wiki-outline-fold" aria-label={`${t(closed ? "wikiOutlineExpand" : "wikiOutlineCollapse")} ${node.text}`} aria-expanded={!closed} onClick={() => setCollapsed(previous => {
					const next = new Set(previous); if (closed) next.delete(node.element); else next.add(node.element); return next;
				})}>{closed ? <FiChevronRight /> : <FiChevronDown />}</button> : <span className="wiki-outline-spacer" />}
				<button className="wiki-outline-link" title={node.text} aria-current={visibleActive === node.element ? "location" : undefined} onClick={() => {
					if (!node.element.isConnected) return;
					node.element.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
					onNavigate();
				}}>{node.text}</button>
			</div>
			{node.children.length > 0 && !closed && render(node.children)}
		</li>;
	})}</ul>;
	return <nav className="wiki-outline" aria-label={t("richToc")}>
		<div className="wiki-outline-tools">
			<strong>{t("wikiOutlineTitle")}</strong>
			<button title={t(hidden ? "wikiOutlineShow" : "wikiOutlineHide")} aria-label={t(hidden ? "wikiOutlineShow" : "wikiOutlineHide")} aria-expanded={!hidden} onClick={() => setHidden(value => !value)}>{hidden ? <FiEye /> : <FiEyeOff />}</button>
			<button title={t(allCollapsed ? "wikiOutlineExpandAll" : "wikiOutlineCollapseAll")} aria-label={t(allCollapsed ? "wikiOutlineExpandAll" : "wikiOutlineCollapseAll")} disabled={!branches.length || hidden} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(branches))}><FiList /></button>
		</div>
		{!hidden && (headings.length ? render(tree) : <p>{t("wikiOutlineEmpty")}</p>)}
	</nav>;
}
