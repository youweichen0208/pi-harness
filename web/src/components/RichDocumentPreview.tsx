import { useLayoutEffect, useRef } from "react";
import { mountRichDocument, prepareRichDocument, readRichDocument, type RichDocument } from "../rich-markdown";
import { useT } from "../i18n";
import type { RichEditorHost } from "./RichMarkdownEditor";
/** Same document codec as editing; only checkboxes and disclosure controls are interactive. */
export function RichDocumentPreview({ value, onChange, host }: { value: string; onChange: (value: string) => void; host: RichEditorHost }) {
	const t = useT(), root = useRef<HTMLDivElement>(null), state = useRef<RichDocument | null>(null);
	useLayoutEffect(() => {
		if (!root.current) return;
		state.current = prepareRichDocument(value);
		mountRichDocument(root.current, state.current, { source: t("richSourceBlock"), toc: t("richToc"), tocEmpty: t("richTocEmpty"), tocRemove: t("richTocRemove") });
		root.current.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => { input.disabled = false; });
		root.current.querySelectorAll<HTMLImageElement>("img").forEach(img => { const src = img.getAttribute("src") ?? ""; img.dataset.richImageSrc = src; img.src = host.resolveImage(src); });
	}, [value, host, t]);
	return <div ref={root} className="md notes-preview" onInput={e => {
		const input = e.target as HTMLInputElement;
		if (input.type === "checkbox" && root.current && state.current) { input.toggleAttribute("checked", input.checked); onChange(readRichDocument(root.current, state.current)); }
	}} onClick={e => { const link = (e.target as HTMLElement).closest("a"); if (link) { e.preventDefault(); if (/^(https?:|mailto:)/i.test(link.href)) window.open(link.href,"_blank","noopener,noreferrer"); } }} />;
}
