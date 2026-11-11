import { useT } from "../i18n";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { FiCalendar, FiClock, FiLink } from "react-icons/fi";
import { LuMoveHorizontal } from "react-icons/lu";
import type { DocumentHost } from "./RichMarkdownEditor";

/** A meta line under the document title. Hosts compute the values; the canvas only renders them. */
export interface DocumentChip {
	icon: "calendar" | "clock" | "tag" | "citations";
	label: string;
	/** Present on the citations chip: scroll to the backlink section. */
	onClick?: () => void;
}

export interface DocumentBacklink {
	path: string;
	snippet: string;
	/** Opening a backlink belongs to the host: Wiki navigates, the dialog reopens. */
	onOpen?: () => void;
}

/**
 * The reading canvas shared by Wiki documents and the single-document dialog:
 * title, meta chips, optional properties, the rich editor, and a backlink list.
 * Everything that differs between hosts arrives as props; this component owns only
 * the rich/source switch and the layout.
 */
export function DocumentReading({ title, chips, properties, sourceLabel, editor,
	sourceEditor, source, onToggleSource, sourceEnabled, backlinks, backlinksReady, backlinksTitle,
	backlinksEmpty, backlinksMore, onShowMoreBacklinks, backlinksLoading, onMouseUp, onKeyUp, onClick, articleRef }: {
	title: string;
	chips: DocumentChip[];
	properties?: ReactNode;
	sourceLabel?: string;
	editor: ReactNode;
	/** Rendered instead of `editor` while `source` is true. The host picks the code editor. */
	sourceEditor?: ReactNode;
	source?: boolean;
	onToggleSource?: () => void;
	sourceEnabled?: boolean;
	backlinks?: DocumentBacklink[];
	backlinksReady?: boolean;
	backlinksTitle?: string;
	backlinksEmpty?: string;
	backlinksMore?: string;
	onShowMoreBacklinks?: () => void;
	backlinksLoading?: string;
	onMouseUp?: (event: React.MouseEvent) => void;
	onKeyUp?: (event: React.KeyboardEvent) => void;
	onClick?: (event: React.MouseEvent) => void;
	articleRef?: React.Ref<HTMLElement>;
}) {
	const t = useT();
	const [internalSource, setInternalSource] = useState(false);
	const showingSource = source ?? internalSource;
	const effectiveSource = sourceEnabled === false ? false : showingSource;
	return <article ref={articleRef} className={`wiki-document ${effectiveSource ? "is-source" : ""}`} onMouseUp={onMouseUp} onKeyUp={onKeyUp} onClick={onClick}>
		<header className="wiki-document-heading">
			<h1>{title}</h1>
			{chips.length > 0 && <div className="wiki-document-meta">
				{chips.map((chip, index) => chip.onClick
					? <button type="button" className="wiki-meta-chip wiki-meta-link" key={index} onClick={chip.onClick}>{chipIcon(chip.icon)}{chip.label}</button>
					: <span className={`wiki-meta-chip${chip.icon === "tag" ? " wiki-meta-tag" : ""}`} key={index}>{chipIcon(chip.icon)}{chip.label}</span>)}
			</div>}
			{properties}
		</header>
		{sourceLabel && effectiveSource && <div className="wiki-code-hint">{sourceLabel}</div>}
		{effectiveSource ? sourceEditor : editor}
		{backlinks && (backlinksReady || backlinks.length > 0) && <section className="wiki-backlinks">
			<h2><FiLink />{backlinksTitle ?? t("wikiBacklinks")} <span>{backlinksReady ? backlinks.length : backlinksLoading ?? t("loading")}</span></h2>
			{backlinks.map((link, index) => <button key={`${link.path}:${index}`} onClick={link.onOpen} disabled={!link.onOpen}><strong>{link.path}</strong><span>{link.snippet}</span></button>)}
			{onShowMoreBacklinks && <button onClick={onShowMoreBacklinks}>{backlinksMore ?? t("wikiLoadMore")}</button>}
			{!backlinksReady && <p>{backlinksLoading ?? t("wikiReferencesLoading")}</p>}
			{backlinksReady && !backlinks.length && <p>{backlinksEmpty ?? t("wikiNoBacklinks")}</p>}
		</section>}
	</article>;
}

function chipIcon(icon: DocumentChip["icon"]): ReactNode {
	if (icon === "calendar") return <FiCalendar />;
	if (icon === "clock") return <FiClock />;
	return <FiLink />;
}

/** Wide-layout switch; Wiki only, the dialog has no reader layout. */
export function DocumentWidthToggle({ focused, onToggle }: { focused: boolean; onToggle: () => void }) {
	const t = useT();
	return <button className="wiki-source-toggle" title={t(focused ? "wikiStandardWidth" : "wikiWideWidth")} aria-label={t(focused ? "wikiStandardWidth" : "wikiWideWidth")} aria-pressed={focused} onClick={onToggle}><LuMoveHorizontal /></button>;
}

export interface DocumentChipInput {
	updatedAt?: Date;
	minutes?: number;
	tags?: string[];
}

/** Chips are host data: each host decides which of them its document really has. */
export function documentChips({ updatedAt, minutes, tags = [] }: DocumentChipInput, format: { updatedAt?: (date: Date) => string; minutes?: (value: number) => string }): DocumentChip[] {
	const chips: DocumentChip[] = [];
	if (updatedAt && format.updatedAt) chips.push({ icon: "calendar", label: format.updatedAt(updatedAt) });
	if (minutes !== undefined && format.minutes) chips.push({ icon: "clock", label: format.minutes(minutes) });
	for (const tag of tags) chips.push({ icon: "tag", label: `#${tag}` });
	return chips;
}

/** The toolbar host renders into the slot once, independent of the mounted document. */
export function DocumentToolbarSlot({ onHost }: { onHost: (node: HTMLElement | null) => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => { onHost(ref.current); return () => onHost(null); }, [onHost]);
	return <div className="document-toolbar-slot" ref={ref} />;
}

export type { DocumentHost };
