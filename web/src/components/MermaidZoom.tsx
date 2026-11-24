import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiX, FiZoomIn, FiZoomOut } from "react-icons/fi";
import { useT } from "../i18n";

/** Native top-layer dialog also works above the single-document modal. */
export function MermaidZoom({ svg, onClose }: { svg: string; onClose: () => void }) {
	const t = useT();
	const dialog = useRef<HTMLDialogElement>(null);
	const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
	const [scale, setScale] = useState(1);
	const markup = useMemo(() => {
		// Mermaid labels can contain HTML void tags such as <br>. Parse them
		// exactly as the inline diagram does, rather than requiring XML syntax.
		const doc = new DOMParser().parseFromString(svg, "text/html");
		const root = doc.querySelector("svg");
		if (!root) return "";
		// Keep SVG CSS, markers and labels intact without duplicating inline IDs.
		const nodes = [root, ...root.querySelectorAll("*")];
		const ids = new Map(nodes.filter(node => node.id).map(node => [node.id, `zoom-${node.id}`]));
		for (const node of nodes) {
			for (const attribute of [...node.attributes]) {
				let value = attribute.value;
				if (attribute.name === "id") value = ids.get(value) ?? value;
				else if (attribute.name === "aria-labelledby" || attribute.name === "aria-describedby") value = value.split(/\s+/).map(id => ids.get(id) ?? id).join(" ");
				else if (attribute.localName === "href" && value.startsWith("#")) value = `#${ids.get(value.slice(1)) ?? value.slice(1)}`;
				else value = value.replace(/url\(#([^)]*)\)/g, (match, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : match);
				attribute.value = value;
			}
			if (node.localName === "style") node.textContent = (node.textContent ?? "").replace(/#([\w-]+)/g, (match, id: string) => ids.has(id) ? `#${ids.get(id)}` : match);
		}
		return new XMLSerializer().serializeToString(root);
	}, [svg]);
	useEffect(() => {
		const element = dialog.current!;
		element.showModal();
		return () => element.close();
	}, []);
	return createPortal(<dialog ref={dialog} className="mermaid-zoom-dialog" aria-label={t("mermaidExpand")}
		onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
		onKeyDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
		<div className="mermaid-zoom-tools">
			<button type="button" aria-label={t("mermaidZoomOut")} disabled={scale <= 0.25} onClick={() => setScale(value => Math.max(0.25, value / 1.25))}><FiZoomOut /></button>
			<button type="button" aria-label={t("resetZoom")} onClick={() => setScale(1)}>{Math.round(scale * 100)}%</button>
			<button type="button" aria-label={t("mermaidZoomIn")} disabled={scale >= 8} onClick={() => setScale(value => Math.min(8, value * 1.25))}><FiZoomIn /></button>
			<button type="button" aria-label={t("closeZoom")} onClick={onClose}><FiX /></button>
		</div>
		<div className="mermaid-zoom-stage"
			onPointerDown={event => {
				const stage = event.currentTarget;
				if (event.pointerType === "touch" || event.button !== 0 || !event.isPrimary) return;
				if (stage.scrollWidth <= stage.clientWidth && stage.scrollHeight <= stage.clientHeight) return;
				event.preventDefault();
				drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
				stage.setPointerCapture(event.pointerId);
			}}
			onPointerMove={event => {
				const start = drag.current;
				if (start?.id !== event.pointerId) return;
				event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
				event.currentTarget.scrollTop = start.top + start.y - event.clientY;
			}}
			onLostPointerCapture={() => { drag.current = null; }}>
			<div className="mermaid-zoom-content" style={{ width: `${scale * 100}%` }} dangerouslySetInnerHTML={{ __html: markup }} />
		</div>
	</dialog>, document.body);
}
