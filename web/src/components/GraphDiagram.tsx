import { useId, useMemo, type KeyboardEvent } from "react";
import { useT } from "../i18n";

export interface DiagramNode {
	id: string;
	label: string;
	caption: string;
}

export interface DiagramLink {
	id: string;
	from: string;
	to: string;
}

function activate(event: KeyboardEvent<SVGGElement>, action: () => void) {
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		action();
	}
}

/** Layer the bounded result by directed distance. Cycles and isolated nodes get a new root. */
export function GraphDiagram({ nodes, links, onNode, onEdge }: {
	nodes: DiagramNode[];
	links: DiagramLink[];
	onNode: (id: string) => void;
	onEdge: (id: string) => void;
}) {
	const t = useT();
	const marker = useId().replace(/:/g, "");
	const diagram = useMemo(() => {
		const byId = new Map(nodes.map(node => [node.id, node]));
		const ids = new Set<string>();
		for (const id of [...links.flatMap(link => [link.from, link.to]), ...byId.keys()]) {
			if (byId.has(id) && ids.size < 18) ids.add(id);
		}
		const visible = links.filter(link => ids.has(link.from) && ids.has(link.to) && link.from !== link.to);
		const targets = new Set(visible.map(link => link.to));
		const rank = new Map<string, number>();
		const layer = (root: string) => {
			if (rank.has(root)) return;
			rank.set(root, 0);
			const queue = [root];
			for (let i = 0; i < queue.length; i++) {
				const from = queue[i];
				for (const link of visible) {
					if (link.from !== from || rank.has(link.to)) continue;
					rank.set(link.to, Math.min(3, rank.get(from)! + 1));
					queue.push(link.to);
				}
			}
		};
		for (const id of ids) if (!targets.has(id)) layer(id);
		for (const id of ids) layer(id);
		const rows: number[] = [];
		const boxes = new Map(Array.from(ids, id => {
			const col = rank.get(id) ?? 0;
			const row = rows[col] ?? 0;
			rows[col] = row + 1;
			return [id, { x: 18 + col * 190, y: 18 + row * 74, node: byId.get(id)! }] as const;
		}));
		return { boxes, links: visible, width: Math.max(1, rows.length) * 190, height: Math.max(1, ...rows) * 74 + 8 };
	}, [nodes, links]);
	return <div className="wg-plot">
		<div className="wg-plot-scroll">
			<svg width={diagram.width} height={diagram.height} aria-label={t("graphRelations")} role="group">
				<defs><marker id={marker} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L9 5 L0 10 Z" /></marker></defs>
				{diagram.links.map(link => {
					const a = diagram.boxes.get(link.from)!;
					const b = diagram.boxes.get(link.to)!;
					const forward = b.x > a.x;
					const x1 = a.x + (forward ? 146 : 0), x2 = b.x + (forward ? -3 : 149);
					const y1 = a.y + 24, y2 = b.y + 24;
					const offset = forward ? 22 : -22;
					const d = `M${x1} ${y1} C${x1 + offset} ${y1}, ${x2 - offset} ${y2}, ${x2} ${y2}`;
					return <g key={link.id} className="wg-arc" onClick={() => onEdge(link.id)}>
						<title>{a.node.label} → {b.node.label}</title>
						<path className="wg-hit" d={d} /><path className="wg-line" d={d} markerEnd={`url(#${marker})`} />
					</g>;
				})}
				{Array.from(diagram.boxes.entries(), ([id, { x, y, node }]) =>
					<g key={id} className="wg-box" role="button" tabIndex={0} aria-label={node.label}
						transform={`translate(${x},${y})`} onClick={() => onNode(id)} onKeyDown={event => activate(event, () => onNode(id))}>
						<title>{node.caption} · {node.label}</title>
						<rect width="146" height="48" /><text x="10" y="17" className="wg-caption">{short(node.caption)}</text>
						<text x="10" y="36">{short(node.label)}</text>
					</g>)}
			</svg>
		</div>
		{diagram.boxes.size < nodes.length && <small>{t("graphDiagramLimit", { shown: diagram.boxes.size, total: nodes.length })}</small>}
	</div>;
}

function short(value: string) {
	const chars = Array.from(value);
	return chars.length > 17 ? chars.slice(0, 8).join("") + "…" + chars.slice(-8).join("") : value;
}
