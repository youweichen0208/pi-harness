import { useDialogFocus } from "../use-dialog-focus";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiX, FiZoomIn, FiZoomOut } from "react-icons/fi";
import { useT } from "../i18n";

const MIN_SCALE = 0.05, MAX_SCALE = 8, STEP = 1.25;
const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

/** Full-screen viewer for wiki document images: fit-to-window by default, wheel/button zoom, drag to pan. */
export function WikiImageZoom({ image, onClose }: { image: { src: string; alt: string }; onClose: () => void }) {
	const t = useT(), dialog = useDialogFocus<HTMLElement>();
	const stage = useRef<HTMLDivElement>(null);
	const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
	const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
	const [scale, setScale] = useState(1);
	const [panning, setPanning] = useState(false);
	const fitScale = (size = natural) => {
		const box = stage.current;
		if (!box || !size) return 1;
		return clampScale(Math.min(1, (box.clientWidth - 112) / size.width, (box.clientHeight - 112) / size.height));
	};
	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			setScale(current => clampScale(current * (event.deltaY < 0 ? STEP : 1 / STEP)));
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, []);
	return createPortal(<div className="wiki-image-zoom">
		<section ref={dialog} role="dialog" aria-modal="true" aria-label={image.alt || t("wikiImagePreview")} tabIndex={-1} onKeyDown={event => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
		}}>
			<div className="wiki-image-zoom-tools">
				<button aria-label={t("wikiImageZoomOut")} title={t("wikiImageZoomOut")} onClick={() => setScale(current => clampScale(current / STEP))}><FiZoomOut /></button>
				<button className="wiki-image-zoom-level" aria-label={t("resetZoom")} title={t("resetZoom")} onClick={() => setScale(fitScale())}>{Math.round(scale * 100)}%</button>
				<button aria-label={t("wikiImageZoomIn")} title={t("wikiImageZoomIn")} onClick={() => setScale(current => clampScale(current * STEP))}><FiZoomIn /></button>
				<button aria-label={t("closeZoom")} title={t("closeZoom")} onClick={onClose}><FiX /></button>
			</div>
			<div ref={stage} className={`wiki-image-zoom-stage ${panning ? "panning" : ""}`}
				onMouseDown={event => {
					if (event.button !== 0) return;
					if (!(event.target as HTMLElement).closest("img")) { onClose(); return; }
					const box = stage.current;
					if (!box) return;
					pan.current = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
					setPanning(true);
				}}
				onMouseMove={event => {
					const current = pan.current, box = stage.current;
					if (!current || !box) return;
					box.scrollLeft = current.left - (event.clientX - current.x);
					box.scrollTop = current.top - (event.clientY - current.y);
				}}
				onMouseUp={() => { pan.current = null; setPanning(false); }}
				onMouseLeave={() => { pan.current = null; setPanning(false); }}>
				<div className="wiki-image-zoom-frame">
					<img src={image.src} alt={image.alt} draggable={false}
						style={natural ? { width: Math.max(1, Math.round(natural.width * scale)) } : { visibility: "hidden" }}
						onLoad={event => {
							const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
							setNatural(size);
							setScale(fitScale(size));
						}} />
				</div>
			</div>
		</section>
	</div>, document.querySelector(".wiki-document-dialog") ?? document.body);
}
