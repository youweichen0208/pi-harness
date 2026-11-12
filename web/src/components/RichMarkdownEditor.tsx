import { createMath } from "../rich-math";
import { classifyPaste } from "../paste-format";
import { pasteHtml } from "../paste-format-html";
import { copyText } from "../clipboard";
import { RichCommands } from "../rich-commands";
import { editableDisclosures, cleanStyle } from "../rich-content";
import { diffAgainstBaseline, canReplaceBlockTag, mergeBlockFormat, paintedBlockStyle, sampleFormat, type FormatSample, type InlineKey } from "../format-painter";
import { RichFormattingToolbar } from "./RichFormattingToolbar";
import { RichLinkCardDialog } from "./RichLinkCardDialog";
import { decorateWikiTables } from "../wiki-table-presentation";
import {
	cellAt,
	cellIndexFor,
	CELL_TARGET_ATTRIBUTE,
	COLUMN_TARGET_ATTRIBUTE,
	dataCells,
	dataColumn,
	GUTTER_ATTRIBUTE,
	isGutter,
	isHeaderRow,
	ROW_TARGET_ATTRIBUTE,
} from "../table-geometry";
import { WikiTableIcon, WikiQuoteIcon } from "./WikiIcons";
import { WikiToolbar, WikiInsertPopover, type WikiInsertPopup } from "./WikiToolbar";
import { TableSizePicker } from "./TableSizePicker";
import { MermaidDiagram } from "./MermaidDiagram";
import { createPortal } from "react-dom";
import { WikiReadingDialog } from "./WikiReading";
import { TEXT_HIGHLIGHT_COLORS } from "../remark-text-highlight";
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiCalendar, FiBold, FiItalic, FiSquare, FiType, FiCode, FiList, FiCheckSquare, FiMinus, FiLink, FiImage, FiArrowUp, FiArrowDown, FiArrowLeft, FiArrowRight } from "react-icons/fi";
import { markdownImageUrl } from "../markdown-image";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { richCodeText } from "../rich-code-text";
import { createRichCodeHighlighter } from "../rich-code-highlight";
import { useT } from "../i18n";
import { LuHeading2, LuHeading3, LuTableOfContents, LuPanelTop, LuInfo, LuLightbulb, LuTriangleAlert, LuChevronsUpDown, LuListOrdered } from "react-icons/lu";
import { mountRichDocument, prepareRichDocument, readRichDocument, renderToc } from "../rich-markdown";
import type { RichDocument, RichLabels } from "../rich-markdown";

/** The gutter cell as HTML, for templates that insert a table string. */
function gutterHtml(): string {
	return `<td ${GUTTER_ATTRIBUTE}="" data-rich-ui="" contenteditable="false" aria-hidden="true"></td>`;
}

/**
 * Give every row the editor-only row gutter. Header rows get one too — a `th`
 * so `isHeaderRow` and header-cell semantics stay intact — because a header row
 * without it put the header's first cell and the body's gutter in the same visual
 * column: the gutter stretched to that cell's width and every header label sat one
 * column left of the body it named. The gutter carries `data-rich-ui`, which
 * `readRichDocument` strips, so it never reaches saved Markdown.
 */
function syncGutters(table: HTMLTableElement, selectRowLabel: string): void {
	for (const tr of Array.from(table.rows)) {
		const header = isHeaderRow(tr);
		const first = tr.cells[0];
		if (first && isGutter(first)) {
			// Keep the hint in step with the row kind: only a data row's strip selects a row.
			if (header) first.removeAttribute("title");
			else if (!first.getAttribute("title")) first.setAttribute("title", selectRowLabel);
			continue;
		}
		const gutter = document.createElement(header ? "th" : "td");
		gutter.setAttribute(GUTTER_ATTRIBUTE, "");
		gutter.setAttribute("data-rich-ui", "");
		gutter.contentEditable = "false";
		gutter.setAttribute("aria-hidden", "true");
		// A data row's strip is a control: say what it does. The header's strip only
		// aligns the columns, so it stays silent and non-interactive.
		if (!header) gutter.setAttribute("title", selectRowLabel);
		tr.prepend(gutter);
	}
}

/** An editable landing line outside the final quote/list/code block; empty UI is not saved. */
function ensureTrailingParagraph(root: HTMLElement): void {
	for (const tail of root.querySelectorAll<HTMLElement>(":scope > [data-rich-tail]")) {
		if (tail.textContent || tail.querySelector("img,table,pre,hr,input")) tail.removeAttribute("data-rich-tail");
	}
	const last = root.lastElementChild;
	if (last?.matches("p[data-rich-tail]")) return;
	const paragraph = root.ownerDocument.createElement("p");
	paragraph.dataset.richTail = "";
	paragraph.append(root.ownerDocument.createElement("br"));
	root.append(paragraph);
}


export interface RichEditorHost {
	uploadImage: (data: string, signal: AbortSignal) => Promise<string>;
	resolveImage: (source: string) => string;
	/** Offer a Run control on Java code blocks. Only the Notes host provides it,
	 *  so the Wiki host deliberately gets no Run control. */
	runCode?: (code: string) => void;
}
/**
 * Document-canvas capabilities, declared by each host. Wiki and the single-document
 * dialog both render this editor but offer different ones; an absent field means
 * that host has none of it, so the editor can drop the whole affordance.
 */
export interface DocumentHost {
	/** Mount point for the single-line format/insert toolbar; `variant` picks the skin. */
	toolbar?: { host: HTMLElement; variant: "wiki" | "compat" };
	/** Internal link handling; `paths` missing means no `[[` completion is offered. */
	links?: { paths?: string[]; open: (href: string) => void };
	/** Ask pi about a selection. Missing means no floating toolbar and no per-code ask button. */
	ask?: (text: string) => void;
	/** Standard/wide width toggle. Missing means no width control anywhere. */
	width?: { focused: boolean; onToggle: () => void };
	/** Lines pi just added, highlighted in the body. */
	added?: Set<string>;
	/** Resolve a code span to a document path; matched spans become links. */
	resolveCode?: (value: string) => string | undefined;
}
export const RichMarkdownEditor = memo(function RichMarkdownEditor({ value, readOnly, onChange, file = { cwd: "", path: "" }, documentHost, host, compact = false }: {
	file?: { cwd: string; path: string };
	host?: RichEditorHost;
	compact?: boolean;
	documentHost?: DocumentHost;
	value: string;
	readOnly: boolean;
	onChange: (value: string) => void;
}) {
	const t = useT();
	const wiki = documentHost;
	const [mathInput, setMathInput] = useState<{ source: string; display: boolean } | null>(null);
	const mathRange = useRef<Range | null>(null);
	const openMath = (element: HTMLElement) => {
		if (readOnly) return;
		const range = document.createRange(); range.selectNode(element); mathRange.current = range;
		setMathInput({ source: element.dataset.richMath ?? "", display: element.dataset.richMathDisplay === "true" });
	};
	const [cardOpen, setCardOpen] = useState(false);
	const cardRange = useRef<Range | null>(null);
	const [insertPopup, setInsertPopup] = useState<WikiInsertPopup | null>(null);
	const savedRange = useRef<Range | null>(null);
	const [diagrams, setDiagrams] = useState<{ host: HTMLElement; code: string }[]>([]);
	const openMermaidSource = useRef(new WeakSet<HTMLElement>());
	const didFocus = useRef(false);
	const [uploading, setUploading] = useState(false);
	const [imageError, setImageError] = useState("");
	const upload = useRef<AbortController | null>(null);
	const readOnlyRef = useRef(readOnly);
	readOnlyRef.current = readOnly;
	useEffect(() => () => { upload.current?.abort(); }, []);

	const root = useRef<HTMLDivElement>(null);
	const codeHighlighter = useRef<ReturnType<typeof createRichCodeHighlighter> | null>(null);
	useEffect(() => () => { codeHighlighter.current?.dispose(); codeHighlighter.current = null; }, []);
	const paintCode = (code: HTMLElement, lazy = false) => {
		codeHighlighter.current ??= createRichCodeHighlighter(!!wiki);
		if (lazy) codeHighlighter.current.observe(code);
		else codeHighlighter.current.update(code);
	};
	const selectedCode = () => {
		const selection = window.getSelection(), node = selection?.anchorNode;
		const element = node instanceof Element ? node : node?.parentElement;
		const code = element?.closest<HTMLElement>("pre > code");
		return code && root.current?.contains(code) && selection?.focusNode && code.contains(selection.focusNode) ? code : null;
	};
	const [floating, setFloating] = useState<{ x: number; y: number } | null>(null);
	// Format painter: `sampled` holds one capture and is applied on the next gesture;
	// `sticky` keeps it armed after painting until Escape or a second toggle. Both live
	// outside RichCommands because they outlive a single command execution.
	const [painter, setPainter] = useState<{ sampled: FormatSample; sticky: boolean } | null>(null);
	const painterRef = useRef(painter);
	painterRef.current = painter;
	// Whether the caret currently sits somewhere a sample can be taken. `null` means
	// "not measured yet", which keeps the button enabled rather than flickering off.
	const [samplable, setSamplable] = useState<boolean | null>(null);
	// Cheap, side-effect free version of "would sampling find anything?". A block with no
	// text and no marked formatting has nothing to copy; anything else can be sampled.
	const canSample = (selection: Selection | null): boolean => {
		if (!root.current || !selection?.rangeCount || !root.current.contains(selection.anchorNode)) return false;
		const anchor = selection.anchorNode;
		const element = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
		const block = element?.closest<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,div");
		return !!block && root.current.contains(block) && !!block.textContent?.trim();
	};
	useEffect(() => {
		if (!painter) return;
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); setPainter(null); }
		};
		window.addEventListener("keydown", escape);
		return () => window.removeEventListener("keydown", escape);
	}, [!!painter]);
	useEffect(() => {
		if (!wiki || !floating) return;
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); setFloating(null); }
		};
		window.addEventListener("keydown", escape);
		return () => window.removeEventListener("keydown", escape);
	}, [wiki, floating]);
	// Selection may survive blur, and IME/input need not move it. Track those events too.
	const wikiPlaceholder = wiki ? t("wikiEmptyParagraph") : null;
	useEffect(() => {
		const editor = root.current;
		if (!editor) return;
		let composing = false;
		const clear = () => editor.querySelectorAll("[data-wiki-placeholder]").forEach(el => el.removeAttribute("data-wiki-placeholder"));
		const refresh = () => {
			clear();
			const selection = window.getSelection();
			if (!wikiPlaceholder || readOnly || composing || document.activeElement !== editor || !selection?.isCollapsed) return;
			const anchor = selection.anchorNode;
			const paragraph = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest("p, div");
			if (!paragraph || paragraph === editor || !editor.contains(paragraph) || paragraph.textContent
				|| paragraph.closest("table, li, pre, [contenteditable=false], [data-rich-ui]")
				|| paragraph.querySelector("p, div, table, ul, ol, pre, img, code, hr, input")) return;
			paragraph.setAttribute("data-wiki-placeholder", wikiPlaceholder);
		};
		const compositionStart = () => { composing = true; clear(); };
		const compositionEnd = () => { composing = false; refresh(); };
		document.addEventListener("selectionchange", refresh);
		editor.addEventListener("input", refresh);
		editor.addEventListener("focus", refresh);
		editor.addEventListener("blur", clear);
		editor.addEventListener("compositionstart", compositionStart);
		editor.addEventListener("compositionend", compositionEnd);
		refresh();
		return () => {
			clear();
			document.removeEventListener("selectionchange", refresh);
			editor.removeEventListener("input", refresh);
			editor.removeEventListener("focus", refresh);
			editor.removeEventListener("blur", clear);
			editor.removeEventListener("compositionstart", compositionStart);
			editor.removeEventListener("compositionend", compositionEnd);
		};
	}, [wikiPlaceholder, readOnly]);
	// Sampling reads the live style of whatever the caret touches. It stays here, not in
	// format-painter.ts, so that module remains DOM-free and unit-testable.
	const sampleAt = (): FormatSample | null => {
		const selection = window.getSelection();
		if (!root.current || !selection?.rangeCount || !root.current.contains(selection.anchorNode)) return null;
		let node: Node | null = selection.anchorNode;
		if (!node) return null;
		if (node.nodeType === Node.ELEMENT_NODE && selection.isCollapsed) node = node.childNodes[selection.anchorOffset] ?? node;
		const startsInBlock = (value: Node) => value instanceof HTMLElement && !!value.closest("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote");
		while (node.firstChild && !startsInBlock(node)) node = node.firstChild;
		const element = node instanceof HTMLElement ? node : node?.parentElement;
		const block = element?.closest<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote") ?? element?.closest<HTMLElement>("div");
		if (!block || !root.current.contains(block)) return null;
		const sampled = sampleFormat(cleanStyle(getComputedStyle(element ?? block)), block.tagName);
		// Resolved styles carry inherited defaults; diff them against a pristine block of
		// the same tag so painting copies intent rather than the document's baseline.
		const baseline = baselineFor(block);
		const trimmed = baseline ? diffAgainstBaseline(sampled, baseline) : sampled;
		return block.textContent?.trim() ? trimmed : null;
	};
	// A detached clone measures what "unformatted" looks like here. The baseline is a
	// plain paragraph on purpose: comparing against the same tag would hide a heading's
	// own styling and leave nothing to copy.
	const baselineFor = (block: HTMLElement): FormatSample | null => {
		const holder = document.createElement("div");
		holder.style.cssText = "position: absolute; visibility: hidden; pointer-events: none; width: 0; height: 0; overflow: hidden";
		const copy = document.createElement("p");
		copy.textContent = "x";
		holder.append(copy);
		(block.parentElement ?? root.current ?? document.body).append(holder);
		const measured = sampleFormat(cleanStyle(getComputedStyle(copy)), block.tagName);
		holder.remove();
		return measured;
	};
	const [linkInput, setLinkInput] = useState<string | null>(null);
	const linkRange = useRef<Range | null>(null), imageRange = useRef<Range | null>(null);
	const imageInput = useRef<HTMLInputElement>(null);
	const popup = useRef<HTMLDivElement>(null), floatingToolbar = useRef<HTMLDivElement>(null);
	const highlightSelection = () => {
		const selection = window.getSelection();
		if (!selection?.rangeCount || selection.isCollapsed || !root.current?.contains(selection.anchorNode) || !root.current.contains(selection.focusNode)) return null;
		const range = selection.getRangeAt(0);
		if ([...root.current.querySelectorAll("pre, code, [contenteditable=false]")].some(node => range.intersectsNode(node))) return null;
		return range;
	};
	useEffect(() => {
		const changed = () => {
			const selection = window.getSelection();
			if (selection?.rangeCount && root.current?.contains(selection.anchorNode) && root.current.contains(selection.focusNode)) savedRange.current = selection.getRangeAt(0).cloneRange();
			// Mirror the painter's own reachability test so an unreachable caret disables
			// the button instead of letting the click silently do nothing.
			// An empty block has nothing worth copying, so it disables too. This mirrors
			// `sampleAt`, which also returns null for the same case.
			setSamplable(canSample(selection));
			const range = highlightSelection();
			if (!range) { setFloating(null); return; }
			const rect = range.getBoundingClientRect();
			if (rect.bottom < 0 || rect.top > window.innerHeight) { setFloating(null); return; }
			setFloating({ x: Math.max(8, Math.min(rect.left + rect.width / 2 - 160, window.innerWidth - 328)), y: rect.top >= 50 ? rect.top - 46 : Math.min(rect.bottom + 8, window.innerHeight - 46) });
		};
		document.addEventListener("selectionchange", changed);
		window.addEventListener("scroll", changed, true);
		window.addEventListener("resize", changed);
		return () => { document.removeEventListener("selectionchange", changed); window.removeEventListener("scroll", changed, true); window.removeEventListener("resize", changed); };
	}, []);
	useLayoutEffect(() => {
		const toolbar = floatingToolbar.current, range = highlightSelection();
		if (!toolbar || !range) return;
		const rect = range.getBoundingClientRect();
		toolbar.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - toolbar.offsetWidth / 2, window.innerWidth - toolbar.offsetWidth - 8))}px`;
		toolbar.style.top = `${Math.max(8, rect.top >= toolbar.offsetHeight + 8 ? rect.top - toolbar.offsetHeight - 8 : Math.min(rect.bottom + 8, window.innerHeight - toolbar.offsetHeight - 8))}px`;
	}, [floating]);
	const documentState = useRef<RichDocument | null>(null);
	const [menu, setMenu] = useState<{ query: string; x: number; y: number } | null>(null);
	const [active, setActive] = useState(0);
	const [recentInsertions, setRecentInsertions] = useState<string[]>(() => {
		try { const stored = JSON.parse(localStorage.getItem("pi-wiki-recent-insertions") ?? "[]"); return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string").slice(0, 3) : []; } catch { return []; }
	});
	const rememberInsertion = (id: string) => {
		const next = [id, ...recentInsertions.filter(item => item !== id)].slice(0, 3);
		setRecentInsertions(next);
		try { localStorage.setItem("pi-wiki-recent-insertions", JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
	};
	const [tableCell, setTableCell] = useState<HTMLTableCellElement | null>(null);
	// Any click outside the table menu closes it; the menu is a portal, so it is not a
	// descendant of the editor root. Escape closes it too: the key handler lives on the
	// editor root, which the portal never reaches.
	useEffect(() => {
		if (!tableMenu) return;
		const dismiss = (event: Event) => {
			// A scroll event targets the element that scrolled, which is routinely the editor
			// root or the block holding the cell the menu was opened on. Only a press may
			// keep the menu: inside it, or on a cell of the table it acts on. Everything
			// else — including every scroll — closes it.
			// Every scroll closes the menu, as it always has: the editor scrolls itself to
			// keep the caret visible, which is exactly when a stale menu is in the way.
			if (event.type !== "mousedown") { closeTableMenu(); return; }
			// A press inside the menu belongs to the menu. A press on any cell of the table
			// it acts on is a right-click re-target, and that press is handled by the
			// editor root first — closing here would tear the menu down under its own
			// opening event, exactly what a second press on the same cell does.
			const target = event.target as Node | null;
			if (target instanceof Element && target.closest(".fp-table-menu")) return;
			const cell = target instanceof Element ? target.closest<HTMLTableCellElement>("th, td") : null;
			if (cell && tableMenu.table.contains(cell)) return;
			closeTableMenu();
		};
		const onKey = (event: KeyboardEvent) => {
			// While one of the menu's count fields has focus the user is typing a number,
			// not editing the document; everything else is a menu shortcut.
			const target = event.target as HTMLElement | null;
			if (event.key !== "Escape" && target?.closest(".fp-table-count")) return;
			if (event.key !== "Escape" || event.isComposing) return;
			event.preventDefault(); event.stopPropagation();
			closeTableMenu();
		};
		document.addEventListener("mousedown", dismiss);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("resize", dismiss);
		window.addEventListener("scroll", dismiss, true);
		return () => {
			document.removeEventListener("mousedown", dismiss);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("resize", dismiss);
			window.removeEventListener("scroll", dismiss, true);
		};
	});
	useEffect(() => {
		const refresh = () => {
			// While the structure menu holds focus (its count fields), the caret belongs to
			// the menu: the document must not act on a selection change or a stale range.
			if (inTableMenu.current) return;
			const selection = window.getSelection();
			const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
			root.current?.querySelectorAll<HTMLTableElement>("table").forEach(table => {
				const contents = document.createRange();
				contents.selectNodeContents(table);
				const selected = !!range && range.compareBoundaryPoints(Range.START_TO_START, contents) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, contents) >= 0;
				table.toggleAttribute("data-table-selected", selected);
			});
			root.current?.querySelectorAll<HTMLElement>("pre > code").forEach(code => {
				const contents = document.createRange(); contents.selectNodeContents(code);
				const selected = !!range && !!code.textContent && range.compareBoundaryPoints(Range.START_TO_START, contents) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, contents) >= 0;
				code.parentElement?.toggleAttribute("data-code-selected", selected);
			});
		};
		refresh();
		document.addEventListener("selectionchange", refresh);
		window.addEventListener("scroll", refresh, true);
		window.addEventListener("resize", refresh);
		return () => {
			document.removeEventListener("selectionchange", refresh);
			window.removeEventListener("scroll", refresh, true);
			window.removeEventListener("resize", refresh);
		};
	}, [tableCell, value]);

	const slashRange = useRef<Range | null>(null);
	const closeMenu = () => { slashRange.current = null; setMenu(null); };
	const emitted = useRef<string | null>(null);
	const labels: RichLabels = { source: t("richSourceBlock"), toc: t("richToc"), tocEmpty: t("richTocEmpty"), tocRemove: t("richTocRemove") };
	useLayoutEffect(() => {
		if (!root.current || value === emitted.current) return;
		closeMenu();
		setTableCell(null);
		const prepared = prepareRichDocument(value, !!wiki);
		mountRichDocument(root.current, prepared, labels);
		editableDisclosures(root.current, t("richCollapse"));
		// Gutters first: every table-derived decoration counts logical columns.
		root.current.querySelectorAll<HTMLTableElement>("table").forEach(table => syncGutters(table, t("richSelectRow")));
		if (wiki) decorateWikiTables(root.current);
		if (wiki) {
			root.current.querySelectorAll<HTMLElement>("pre:has(> code)").forEach(pre => pre.classList.add("codeblock"));
			root.current.querySelectorAll<HTMLElement>("h2").forEach((heading, index) => { heading.id = `wiki-heading-${index}`; });
			if (wiki.added) root.current.querySelectorAll<HTMLElement>("p").forEach(p => { if ([...wiki.added!].some(line => line.trim() && p.textContent?.includes(line))) p.classList.add("wiki-added"); });
			root.current.querySelectorAll<HTMLElement>("code").forEach(code => {
				const resolve = wiki?.resolveCode;
				if (!resolve || code.closest("pre") || !resolve(code.textContent ?? "")) return;
				const link = document.createElement("a"); link.href = `#wiki=${encodeURIComponent(code.textContent ?? "")}`;
				link.textContent = code.textContent; code.replaceChildren(link);
			});
			// Decoration belongs to the render baseline, not to a user's edit.
			root.current.querySelectorAll<HTMLElement>("[data-rich-block]").forEach(block => { prepared.blocks[Number(block.dataset.richBlock)].html = block.innerHTML; });
		}
		if (!readOnly) ensureTrailingParagraph(root.current);
		documentState.current = prepared;
		emitted.current = value;
	}, [value, t]);
	useLayoutEffect(() => {
		const added = wiki?.added;
		if (!added || !root.current) return;
		root.current.querySelectorAll<HTMLElement>("p").forEach(p => p.classList.toggle("wiki-added", [...added].some(line => line.trim() && p.textContent?.includes(line))));
	}, [wiki?.added, value]);
	useLayoutEffect(() => {
		root.current?.querySelectorAll<HTMLTableElement>("table").forEach(table => {
			// Loaded documents, pasted tables and template inserts all need the same
			// gutter, or the geometry module would mis-read their columns.
			syncGutters(table, t("richSelectRow"));
			// A table with no data-cell content is an empty template (fresh /table insert
			// or fully cleared): stretch it across the prose width instead of leaving a
			// large blank area to its right. Any content shrinks it back.
			const empty = [...table.querySelectorAll("td")].every(cell => isGutter(cell) || (!cell.textContent?.trim() && !cell.querySelector("img, video, audio")));
			table.classList.toggle("rich-table-empty", empty);
		});
	}, [value]);
	useLayoutEffect(() => {
		if (readOnly) closeMenu();
		root.current?.querySelectorAll<HTMLElement>("[data-rich-math]").forEach(element => { element.tabIndex = readOnly ? -1 : 0; element.setAttribute("role", readOnly ? "math" : "button"); element.setAttribute("aria-label", `${t("richMath")}: ${element.dataset.richMath}`); });
		root.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => { input.disabled = readOnly; });
	}, [readOnly, value]);
	useLayoutEffect(() => {
		root.current?.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
			const pre = code.parentElement!;
			if (wiki) pre.classList.add("codeblock");
			let chrome = pre.querySelector<HTMLElement>(".fp-code-language");
			if (!chrome) {
				chrome = document.createElement("span");
				chrome.dataset.richUi = "";
				chrome.contentEditable = "false";
				chrome.className = "fp-code-language";
				if (wiki) {
					const copy = document.createElement("button"); copy.type = "button"; copy.textContent = t("copy");
					copy.onmousedown = event => event.preventDefault();
					copy.onclick = () => { void copyText(richCodeText(code), code.ownerDocument).then(() => { copy.textContent = t("copied"); }, () => { copy.textContent = t("copyFailed"); }); };
					chrome.append(copy);
				}
				pre.prepend(chrome);
			}
			if (wiki && !code.classList.contains("language-mermaid")) {
				let gutter = pre.querySelector<HTMLElement>(".wiki-code-gutter");
				if (!gutter) {
					gutter = document.createElement("span"); gutter.className = "wiki-code-gutter"; gutter.dataset.richUi = ""; gutter.contentEditable = "false"; gutter.setAttribute("aria-hidden", "true"); pre.prepend(gutter);
				}
				const text = richCodeText(code), lines = Math.max(1, text.replace(/\n$/, "").split("\n").length);
				gutter.textContent = Array.from({ length: lines }, (_, index) => String(index + 1)).join("\n");
				const chrome = pre.querySelector<HTMLElement>(".fp-code-language")!;
				let fold = chrome.querySelector<HTMLButtonElement>("[data-code-fold]");
				if (!fold) { fold = document.createElement("button"); fold.type = "button"; fold.dataset.codeFold = ""; chrome.prepend(fold); }
				const updateFold = () => { const closed = pre.hasAttribute("data-wiki-code-folded"); fold!.textContent = closed ? "▸" : "▾"; fold!.setAttribute("aria-expanded", String(!closed)); fold!.title = t(closed ? "wikiCodeExpand" : "wikiCodeCollapse"); fold!.setAttribute("aria-label", fold!.title); };
				updateFold(); fold.onmousedown = event => event.preventDefault();
				fold.onclick = () => { pre.toggleAttribute("data-wiki-code-folded"); fold!.focus({ preventScroll: true }); updateFold(); };
				let width = chrome.querySelector<HTMLButtonElement>("[data-code-width]");
				if (!width) { width = document.createElement("button"); width.type = "button"; width.dataset.codeWidth = ""; width.textContent = "↔"; chrome.append(width); }
				if (wiki.width) {
					width.hidden = false;
					width.title = t(wiki.width.focused ? "wikiStandardWidth" : "wikiWideWidth"); width.setAttribute("aria-label", width.title); width.onmousedown = event => event.preventDefault(); width.onclick = () => wiki.width?.onToggle();
				} else width.hidden = true;
			} else {
				pre.querySelector(".wiki-code-gutter")?.remove(); pre.querySelector("[data-code-fold]")?.remove(); pre.querySelector("[data-code-width]")?.remove(); pre.querySelector("[data-code-ask]")?.remove(); pre.removeAttribute("data-wiki-code-folded");
			}
			// Ask pi only exists when the host declares it; hosts without `ask` get no button at all.
			{
				const askCode = wiki?.ask;
				const languageChrome = pre.querySelector<HTMLElement>(".fp-code-language");
				if (askCode && languageChrome) {
					let askButton = languageChrome.querySelector<HTMLButtonElement>("[data-code-ask]");
					if (!askButton) { askButton = document.createElement("button"); askButton.type = "button"; askButton.dataset.codeAsk = ""; languageChrome.append(askButton); }
					askButton.textContent = t("wikiAskPi"); askButton.title = t("wikiAskPi"); askButton.setAttribute("aria-label", t("wikiAskPi"));
					askButton.onmousedown = event => event.preventDefault();
					askButton.onclick = () => askCode(richCodeText(code));
				} else languageChrome?.querySelector("[data-code-ask]")?.remove();
			}
			const detected = code.className.match(/language-([^\s]+)/)?.[1] ?? "";
			const language = detected === "plaintext" ? "" : detected;
			const canRun = !readOnly && !!host?.runCode && ["python", "py", "python3"].includes(language);
			let runButton = chrome.querySelector<HTMLButtonElement>("button[data-code-run]");
			if (canRun && !runButton) {
				runButton = document.createElement("button");
				runButton.type = "button";
				runButton.dataset.codeRun = "";
				runButton.onmousedown = event => event.preventDefault();
				chrome.append(runButton);
			}
			if (!canRun) runButton?.remove();
			else if (runButton) {
				runButton.textContent = t("playgroundRun");
				runButton.title = t("playgroundRun");
				runButton.setAttribute("aria-label", t("playgroundRun"));
				runButton.onclick = () => host!.runCode!(richCodeText(code));
			}
			paintCode(code, true);
		});
	}, [value, readOnly, t, wiki?.width?.focused, wiki?.width, wiki?.ask, host?.runCode]);
	useLayoutEffect(() => {
		root.current?.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
			const source = img.dataset.richImageSrc ?? img.getAttribute("src") ?? "";
			if (!source || /^(?:[a-z]+:|\/\/|#)/i.test(source)) return;
			img.dataset.richImageSrc = source;
			img.src = host ? host.resolveImage(source) : markdownImageUrl(source, file);
		});
	}, [value, file.cwd, file.path]);
	useEffect(() => {
		if (!wiki || readOnly || didFocus.current || !root.current) return;
		didFocus.current = true;
		root.current.focus({ preventScroll: true });
		const range = document.createRange(); range.selectNodeContents(root.current); range.collapse(false);
		window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); savedRange.current = range.cloneRange();
	}, [readOnly]);
	useLayoutEffect(() => {
		if (!root.current) return;
		const next: { host: HTMLElement; code: string }[] = [];
		const caret = window.getSelection()?.anchorNode ?? null;
		root.current.querySelectorAll<HTMLElement>('pre > code.language-mermaid').forEach(code => {
			const pre = code.parentElement!;
			// Wiki documents and plain file previews share the fold behavior; only the
			// preview chrome class differs so each surface keeps its own styling.
			const previewClass = wiki ? 'wiki-mermaid-preview' : 'fp-mermaid-preview';
			let host = pre.querySelector<HTMLElement>('.' + previewClass);
			if (!host) { host = document.createElement('div'); host.dataset.richUi = ''; host.contentEditable = 'false'; host.className = previewClass; pre.prepend(host); }
			// The diagram is the reading view; the source stays folded until the
			// user asks for it or the caret is already inside (fresh insert).
			if (caret && code.contains(caret)) openMermaidSource.current.add(pre);
			const open = openMermaidSource.current.has(pre);
			pre.classList.add('wiki-mermaid');
			pre.classList.toggle('wiki-mermaid-source-hidden', !open);
			const chrome = pre.querySelector<HTMLElement>('.fp-code-language');
			let toggle = chrome?.querySelector<HTMLButtonElement>('button[data-mermaid-source]') ?? null;
			if (chrome && !toggle) {
				toggle = document.createElement('button'); toggle.type = 'button'; toggle.dataset.mermaidSource = '';
				toggle.onmousedown = event => event.preventDefault();
				chrome.prepend(toggle);
			}
			if (toggle) {
				toggle.textContent = t(open ? 'wikiMermaidHideCode' : 'wikiMermaidShowCode');
				toggle.setAttribute('aria-expanded', String(open));
				toggle.onclick = () => {
					if (openMermaidSource.current.has(pre)) openMermaidSource.current.delete(pre); else openMermaidSource.current.add(pre);
					const nowOpen = openMermaidSource.current.has(pre);
					pre.classList.toggle('wiki-mermaid-source-hidden', !nowOpen);
					toggle!.textContent = t(nowOpen ? 'wikiMermaidHideCode' : 'wikiMermaidShowCode');
					toggle!.setAttribute('aria-expanded', String(nowOpen));
				};
			}
			next.push({ host, code: richCodeText(code) });
		});
		root.current.querySelectorAll<HTMLElement>('.wiki-mermaid-preview, .fp-mermaid-preview').forEach(host => { if (!next.some(item => item.host === host)) host.remove(); });
		root.current.querySelectorAll<HTMLElement>('pre.wiki-mermaid').forEach(pre => {
			if (pre.querySelector('code.language-mermaid')) return;
			pre.classList.remove('wiki-mermaid', 'wiki-mermaid-source-hidden');
			pre.querySelector('button[data-mermaid-source]')?.remove();
		});
		setDiagrams(next);
	}, [value, t, wiki]);
	const selectedCell = () => {
		const node = window.getSelection()?.anchorNode;
		const element = node instanceof Element ? node : node?.parentElement;
		const cell = element?.closest<HTMLTableCellElement>("th, td") ?? null;
		return cell && root.current?.contains(cell) ? cell : null;
	};
	const focusCell = (cell: HTMLTableCellElement) => placeCaretIn(cell);
	/** The caret as it stands, or null when there is none in the document. */
	const caretRange = () => {
		const selection = window.getSelection();
		const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
		return range && root.current?.contains(range.startContainer) ? range : null;
	};
	/**
	 * The table target is editor state, not a text range: selecting a row or a
	 * column must not move the caret or touch the document. Everything the table
	 * menu acts on is resolved through this one place (see table-geometry.ts for
	 * why the gutter makes DOM and logical column indexes differ).
	 */
	type TableAction = "numberRows" | "numberColumn" | "clearCells" | "rowAbove" | "rowBelow" | "columnLeft" | "columnRight" | "removeRow" | "removeColumn" | "removeTable" | "selectTable" | "left" | "center" | "right";
	type TableTarget = { table: HTMLTableElement; row: number; column: number; selectedRows?: number[]; selectedColumns?: number[] };
	const [rowTarget, setRowTarget] = useState<number | null>(null);
	const [columnTarget, setColumnTarget] = useState<number | null>(null);
	const [tableMenu, setTableMenu] = useState<(TableTarget & { x: number; y: number }) | null>(null);
	// The menu's count fields, one per axis, reset every time the menu opens.
	const [insertCount, setInsertCount] = useState({ row: "1", column: "1" });
	const [numberStart, setNumberStart] = useState("1");
	const pressedSelection = useRef<TableTarget | null>(null);
	const selectedTableRange = (target: TableTarget): TableTarget | null => {
		const selection = window.getSelection();
		if (!selection?.rangeCount || selection.isCollapsed) return null;
		const range = selection.getRangeAt(0);
		const cellOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLTableCellElement>("th,td");
		if (range.intersectsNode(target.table)) {
			const whole = document.createRange(); whole.selectNode(target.table);
			if (range.compareBoundaryPoints(Range.START_TO_START, whole) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, whole) >= 0) return { ...target, selectedRows: Array.from(target.table.rows, (_, i) => i), selectedColumns: dataCells(target.table.rows[0]).map((_, i) => i) };
		}
		const first = cellOf(range.startContainer), last = cellOf(range.endContainer);
		const a = first && locateCell(first), b = last && locateCell(last);
		if (!a || !b || a.table !== target.table || b.table !== target.table || a.column < 0 || b.column < 0) return null;
		const rows = Array.from({ length: Math.abs(a.row - b.row) + 1 }, (_, i) => Math.min(a.row, b.row) + i);
		const columns = Array.from({ length: Math.abs(a.column - b.column) + 1 }, (_, i) => Math.min(a.column, b.column) + i);
		return rows.includes(target.row) && columns.includes(target.column) ? { ...target, selectedRows: rows, selectedColumns: columns } : null;
	};
	/** True while the structure menu is mounted: its fields are chrome, not content. */
	const inTableMenu = useRef(false);
	// The menu lives in a portal and takes focus when a count field is clicked: the
	// editor's blur handler must not read that as "the user left the document".
	useEffect(() => {
		inTableMenu.current = !!tableMenu;
		return () => { inTableMenu.current = false; };
	}, [!!tableMenu]);
	// A right-click is a press and a release. Our root listeners are native, so the
	// press is handled before the browser collapses the caret and before the release
	// runs; freezing the target on the press keeps the choice that was already on
	// screen instead of trading a selected column for the row that was just clicked.
	const pressedTarget = useRef<{ table: HTMLTableElement; row: number | null; column: number | null } | null>(null);
	/** Logical row / column of a cell, resolved through the geometry module. */
	const locateCell = (cell: HTMLTableCellElement): TableTarget | null => {
		const table = cell.closest("table");
		const tr = cell.parentElement;
		if (!table || !(tr instanceof HTMLTableRowElement)) return null;
		return { table, row: tr.rowIndex, column: dataColumn(cell, tr) };
	};
	/**
	 * Highlight the table target without touching the text selection. Three shapes:
	 * a row band, a column band, or — when `cell` is given — that one cell only.
	 * The right-click menu uses the cell: it acts on that cell's row and column, and
	 * the caret is already in it, so banding both axes only added colour to read.
	 */
	const paintTableTarget = (table: HTMLTableElement | null, row: number | null, column: number | null, cell?: HTMLTableCellElement | null) => {
		setRowTarget(row); setColumnTarget(column);
		root.current?.querySelectorAll<HTMLElement>(`[${ROW_TARGET_ATTRIBUTE}], [${COLUMN_TARGET_ATTRIBUTE}], [${CELL_TARGET_ATTRIBUTE}]`).forEach(node => { node.removeAttribute(ROW_TARGET_ATTRIBUTE); node.removeAttribute(COLUMN_TARGET_ATTRIBUTE); node.removeAttribute(CELL_TARGET_ATTRIBUTE); });
		if (!table) return;
		if (cell && table.contains(cell)) { cell.setAttribute(CELL_TARGET_ATTRIBUTE, ""); return; }
		if (row !== null) table.rows[row]?.setAttribute(ROW_TARGET_ATTRIBUTE, "");
		if (column === null) return;
		for (const tr of Array.from(table.rows)) {
			const index = cellIndexFor(tr, column);
			if (index >= 0) tr.cells[index]?.setAttribute(COLUMN_TARGET_ATTRIBUTE, "");
		}
	};
	/** Clear table targeting when the caret leaves the table or the document reloads. */
	const clearTableTarget = () => {
		if (rowTarget !== null || columnTarget !== null || root.current?.querySelector(`[${CELL_TARGET_ATTRIBUTE}]`)) paintTableTarget(null, null, null);
	};
	/**
	 * Close the structure menu and drop the targets it painted. Every closing path
	 * (Escape, scroll, outside press, the toggling second right-click) goes through
	 * here: a menu that vanishes must not leave its L-shaped highlight behind, or the
	 * document keeps a state the user can no longer act on.
	 */
	const closeTableMenu = () => { setTableMenu(null); paintTableTarget(null, null, null); };
	/**
	 * Give an empty cell the `<br>` placeholder the editor builds its own cells with:
	 * a cell with no node at all has no position the typing engine can hold on to,
	 * which is why a freshly added cell used to look focused and swallow the caret.
	 */
	const caretIn = (cell: HTMLTableCellElement) => {
		if (!cell.firstChild) cell.append(document.createElement("br"));
	};
	/** Move the caret to the start of a cell's content without rewriting it. */
	const placeCaretIn = (cell: HTMLTableCellElement | null | undefined) => {
		if (!cell || !root.current?.contains(cell)) return null;
		root.current.focus({ preventScroll: true });
		caretIn(cell);
		const range = document.createRange();
		range.selectNodeContents(cell); range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges(); selection?.addRange(range);
		setTableCell(cell);
		return range;
	};
	const insertRow = (table: HTMLTableElement, at: number, above: boolean, after?: HTMLTableRowElement | null) => {
		const reference = at < 0 ? table.rows[0] : table.rows[at];
		const added = document.createElement("tr");
		const gutter = added.insertCell();
		gutter.setAttribute(GUTTER_ATTRIBUTE, ""); gutter.setAttribute("data-rich-ui", ""); gutter.contentEditable = "false"; gutter.setAttribute("aria-hidden", "true");
		// One content cell per logical column, which is what the header row holds.
		for (let index = 0; index < Math.max(1, dataCells(reference).length); index += 1) added.insertCell().append(document.createElement("br"));
		const body = table.tBodies[0] ?? table.createTBody();
		// Repeated inserts (a count above one) chain after the row this call just added.
		if (after) after.after(added);
		else if (above && at === 0 && table.tHead) body.prepend(added);
		else if (above) reference.before(added);
		else reference.after(added);
		return added;
	};
	/** The next unused `<column word> N` for this table's header row. */
	const nextColumnNumber = (row: HTMLTableRowElement) => {
		const prefix = t("richColumn");
		let highest = 0;
		for (const cell of Array.from(row.cells)) {
			if (isGutter(cell)) continue;
			const label = cell.textContent?.trim() ?? "";
			const match = label.startsWith(prefix) ? label.slice(prefix.length).trim() : null;
			const value = match && /^\d+$/.test(match) ? Number(match) : 0;
			highest = Math.max(highest, value);
		}
		return highest + 1;
	};
	const insertColumn = (table: HTMLTableElement, column: number, left: boolean) => {
		const rows = Array.from(table.rows);
		const next = left ? column : column + 1;
		// The header defines the truth; data rows shift by their gutter.
		for (const tr of rows) {
			const index = cellIndexFor(tr, column);
			if (index < 0) continue;
			const header = isHeaderRow(tr);
			const cell = document.createElement(header ? "th" : "td");
			cell.style.textAlign = tr.cells[index].style.textAlign;
			if (header) {
				// A nameless column reads as a broken table — that is exactly what a blank
				// header cell looked like once it spanned the page next to real column names.
				// Name it the way the /table template names its columns, continuing from the
				// highest existing number so a grown table never repeats a name.
				cell.textContent = `${t("richColumn")} ${nextColumnNumber(tr)}`;
			} else {
				// A cell with no node has no caret position to hold on to.
				cell.append(document.createElement("br"));
			}
			// `column` is logical while `cells` counts the gutter: the new cell sits at that
			// index on the left and one past it on the right, so it never lands on the
			// gutter and is never appended after a column further right.
			if (left) tr.cells[index].before(cell); else tr.cells[index].after(cell);
		}
		return next;
	};
	/** Insert actions repeat: one gesture for "insert 2 rows" like Yuque's count field. */
	const editTable = (action: TableAction, targetArg?: TableTarget | null, amount?: { row: string; column: string }) => {
		const resolved: TableTarget | null = targetArg ?? tableMenu ?? (tableCell ? locateCell(tableCell) : null);
		if (readOnly || !resolved || !root.current?.contains(resolved.table)) return;
		const target: TableTarget = resolved;
		const original = target.table;
		const table = original.cloneNode(true) as HTMLTableElement;
		const row = table.rows[target.row];
		if (!row) return;
		const column = target.column;
		const selectedRows = target.selectedRows ?? [target.row];
		const selectedColumns = target.selectedColumns ?? [column];
		if (action === "removeTable" || action === "selectTable") {
			const range = document.createRange();
			range.selectNode(original);
			const selection = window.getSelection();
			root.current.focus(); selection?.removeAllRanges(); selection?.addRange(range);
			if (action === "removeTable") { command("delete"); paintTableTarget(null, null, null); setTableCell(null); closeTableMenu(); }
			return;
		}
		if (["left", "center", "right"].includes(action)) {
			const index = cellIndexFor(row, column);
			if (index < 0) return;
			for (const current of Array.from(table.rows)) current.cells[index]?.style.setProperty("text-align", action);
		} else if (action === "rowAbove" || action === "rowBelow") {
			// Counts are clamped: one row is the floor, eight the ceiling, so a stray
			// keystroke cannot turn one menu action into two hundred rows.
			const times = Math.max(1, Math.min(8, Number(amount?.row) || 1));
			let last: HTMLTableRowElement | null = null;
			for (let index = 0; index < times; index += 1) last = insertRow(table, action === "rowAbove" ? target.row : last ? -1 : target.row, action === "rowAbove", last);
		} else if (action === "columnLeft" || action === "columnRight") {
			const times = Math.max(1, Math.min(8, Number(amount?.column) || 1));
			for (let index = 0; index < times; index += 1) insertColumn(table, action === "columnLeft" ? column : column + index, action === "columnLeft");
		} else if (action === "numberRows" || action === "numberColumn") {
			const body = Array.from(table.rows).filter(tr => !isHeaderRow(tr));
			const start = action === "numberColumn" ? 1 : Number(numberStart);
			if (!Number.isInteger(start) || start < 1 || start > body.length) return;
			if (action === "numberColumn") {
				insertColumn(table, 0, true);
				const header = cellAt<HTMLTableCellElement>(table.rows[0], 0);
				if (header && isHeaderRow(table.rows[0])) header.textContent = t("richSequenceColumn");
			}
			body.slice(start - 1).forEach((tr, index) => {
				const cell = cellAt<HTMLTableCellElement>(tr, action === "numberColumn" ? 0 : column);
				if (cell) cell.textContent = String(index + 1);
			});
		} else if (action === "clearCells") {
			for (const rowIndex of selectedRows) for (const col of selectedColumns) {
				cellAt<HTMLTableCellElement>(table.rows[rowIndex], col)?.replaceChildren(document.createElement("br"));
			}
		} else if (action === "removeRow") {
			const removable = selectedRows.filter(index => table.rows[index] && !isHeaderRow(table.rows[index]));
			if (!removable.length || removable.length >= Array.from(table.rows).filter(tr => !isHeaderRow(tr)).length) return;
			removable.sort((a, b) => b - a).forEach(index => table.rows[index].remove());
		} else if (action === "removeColumn") {
			if (selectedColumns.length >= dataCells(row).length) return;
			for (const current of Array.from(table.rows)) for (const col of [...selectedColumns].sort((a, b) => b - a)) {
				const index = cellIndexFor(current, col); if (index >= 0) current.deleteCell(index);
			}
		}
		// Land the caret on a content cell, never the gutter: inserting a row focuses its
		// first data cell, inserting a column focuses the first data cell of that column.
		const nextRow = action === "removeRow" ? Math.max(isHeaderRow(table.rows[0]) ? 1 : 0, Math.min(target.row, table.rows.length - 1)) : (action === "rowAbove" || action === "rowBelow") ? (action === "rowAbove" ? target.row : target.row + 1) : target.row;
		const nextColumn = action === "removeColumn" ? Math.max(0, Math.min(column, dataCells(table.rows[nextRow] ?? row).length - 1)) : (action === "columnLeft" ? column : action === "columnRight" ? column + 1 : column);
		// Where the caret already is decides what happens next: inside the text of a cell
		// the edit left alone, it goes back there; otherwise it lands in the new cell.
		const carried = caretRange();
		if (carried && original.contains(carried.startContainer)) carried.collapse(true);
		table.dataset.richTableChange = "";
		const range = document.createRange(); range.selectNode(original);
		root.current.focus(); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
		root.current.querySelectorAll<HTMLTableElement>("table[data-table-selected]").forEach(other => other.removeAttribute("data-table-selected"));
		command("insertHTML", table.outerHTML);
		closeTableMenu();
		const inserted = root.current.querySelector<HTMLTableElement>("[data-rich-table-change]");
		if (inserted) {
			inserted.removeAttribute("data-rich-table-change");
			syncGutters(inserted, t("richSelectRow"));
			const landing = cellAt<HTMLTableCellElement>(inserted.rows[Math.min(nextRow, inserted.rows.length - 1)], Math.max(0, nextColumn));
			// Put the caret back in the same text when the edit did not touch it (adding a
			// row, adding a column elsewhere); otherwise land at the start of the new cell.
			if (!(carried && landing?.contains(carried.startContainer))) placeCaretIn(landing);
			else { root.current.focus(); selection?.removeAllRanges(); selection?.addRange(carried); setTableCell(landing); }
		}
		update();
	};
	const uploadImageData = async (data: string, signal: AbortSignal): Promise<string> => {
		if (host) return host.uploadImage(data, signal);
		const response = await fetch(withToken("/api/markdown-image"), { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ clientId: getClientId(), cwd: file.cwd, path: file.path, data }) });
		if (!response.ok) throw Error(t("richImageFailed"));
		const result = await response.json(); if (typeof result.path !== "string") throw Error(t("richImageFailed")); return result.path;
	};
	const pasteImage = async (image: File) => {
		if (readOnlyRef.current || upload.current || !root.current) return;
		const selection = window.getSelection();
		if (!selection?.rangeCount || !root.current.contains(selection.anchorNode)) return;
		const range = selection.getRangeAt(0).cloneRange();
		const controller = new AbortController();
		upload.current = controller;
		setUploading(true);
		setImageError("");
		try {
			if (image.size > 5 * 1024 * 1024) throw new Error(t("richImageTooLarge"));
			const data = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result).split(",")[1]);
				reader.onerror = () => reject(new Error(t("richImageFailed")));
				reader.readAsDataURL(image);
			});
			if (controller.signal.aborted) return;
			const path = await uploadImageData(data, controller.signal);
			if (controller.signal.aborted) return;
			if (readOnlyRef.current || !root.current?.contains(range.startContainer)) throw new Error(t("richImageFailed"));
			root.current.focus();
			selection.removeAllRanges();
			selection.addRange(range);
			const img = document.createElement("img");
			img.setAttribute("src", path);
			img.setAttribute("alt", image.name || "screenshot");
			document.execCommand("insertHTML", false, img.outerHTML);
			update();
		} catch (error) {
			if (!controller.signal.aborted) setImageError((error as Error).message === t("richImageTooLarge") ? t("richImageTooLarge") : t("richImageFailed"));
		} finally {
			if (!controller.signal.aborted) setUploading(false);
			if (upload.current === controller) upload.current = null;
		}
	};
	const update = () => {
		if (readOnly || !root.current || !documentState.current) return;
		editableDisclosures(root.current, t("richCollapse"));
		// A structural edit replaces the whole table element, so gutters must exist
		// before anything keyed off logical columns runs.
		root.current.querySelectorAll<HTMLTableElement>("table").forEach(table => syncGutters(table, t("richSelectRow")));
		if (wiki) decorateWikiTables(root.current);
		root.current.querySelectorAll<HTMLElement>(".rich-table-boundary").forEach(paragraph => {
			if (paragraph.textContent || paragraph.querySelector("img, table, pre")) paragraph.classList.remove("rich-table-boundary");
		});
		ensureTrailingParagraph(root.current);
		const next = readRichDocument(root.current, documentState.current);
		// The generated list follows heading edits without touching the caret.
		root.current.querySelectorAll<HTMLElement>("[data-rich-toc]").forEach(toc => renderToc(toc, next, labels));
		emitted.current = next;
		onChange(next);
	};
	/**
	 * Fold the block holding the selection into the editor's own disclosure. The
	 * body keeps its own markup, so nothing is re-parsed; one update() records it as
	 * a single edited fragment.
	 */
	const foldSelection = () => {
		if (readOnly || !root.current) return;
		const selection = window.getSelection();
		const anchorNode = selection?.anchorNode;
		if (!anchorNode || !root.current.contains(anchorNode)) return;
		const holder = (anchorNode instanceof Element ? anchorNode : anchorNode.parentElement)?.closest<HTMLElement>("[data-rich-block]");
		const block = (holder ?? anchorNode as Element).closest<HTMLElement>("[data-rich-block], p, blockquote, table, pre, ul, ol, h1, h2, h3, h4, h5, h6");
		if (!block || !root.current.contains(block) || block.hasAttribute("data-rich-collapse") || block.closest("[data-rich-collapse]")) return;
		const wrap = document.createElement("div");
		wrap.dataset.richCollapse = "";
		const summary = document.createElement("p");
		summary.dataset.richSummary = "";
		summary.textContent = t("richCollapse");
		const body = document.createElement("div");
		body.dataset.richCollapseBody = "";
		block.replaceWith(wrap);
		body.append(block);
		wrap.append(summary, body);
		update();
	};
	/** Adds the maintained block below the title once; an existing one is only scrolled to. */
	const insertToc = () => {
		if (readOnly || !root.current) return;
		const existing = root.current.querySelector<HTMLElement>("[data-rich-toc]");
		if (existing) { existing.scrollIntoView({ block: "nearest" }); return; }
		const children = [...root.current.children] as HTMLElement[];
		let index = children.findIndex(child => !child.hidden);
		if (index >= 0 && children[index].firstElementChild?.tagName === "H1") index++;
		const toc = document.createElement("div");
		toc.className = "rich-block";
		toc.dataset.richToc = "";
		root.current.insertBefore(toc, children[index] ?? null);
		update();
		toc.scrollIntoView({ block: "nearest" });
	};
	/** Headings listed by the block, in the same order as the generated links. */
	const tocTarget = (toc: HTMLElement, index: number) => [...(root.current?.querySelectorAll<HTMLElement>("h1, h2, h3") ?? [])]
		.filter(heading => !heading.closest("li, blockquote, table, [data-rich-toc], [hidden]") && heading.textContent?.trim() && toc.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING)[index];
	const command = (name: string, argument?: string) => {
		if (readOnly || !root.current) return;
		const selection = window.getSelection();
		if (!selection?.anchorNode || !root.current.contains(selection.anchorNode)) root.current.focus();
		document.execCommand(name, false, argument);
		update();
	};
	const allItems = [
		...(([1, 2, 3, 4, 5, 6]) as (1 | 2 | 3 | 4 | 5 | 6)[]).map(level => ({ label: "richHeading", keywords: `heading header title h${level} bt${level} biaoti${level} 标题${level}`, alias: `bt${level}`, action: "formatBlock", argument: `h${level}` } as const)),
		{ label: "richParagraph", alias: "zw", keywords: "paragraph text zw zhengwen 正文", action: "formatBlock", argument: "p" },
		{ label: "richCodeBlock", alias: "dmk", keywords: "code fence dmk daimakuai 代码 代码块", action: "insertHTML", argument: "<pre><code data-slash-insert><br></code></pre><p><br></p>" },
		{ label: "richHighlightBlock", alias: "glk", keywords: "highlight note callout glk gaoliangkuai ts tishi 高亮 提示", action: "insertHTML", argument: '<blockquote class="rich-highlight" data-rich-highlight="note"><p data-slash-insert><br></p></blockquote><p><br></p>' },
		{ label: "richGreenBlock", alias: "tip", keywords: "green callout 绿色 高亮", action: "insertHTML", argument: '<blockquote data-rich-highlight="tip"><p data-slash-insert><br></p></blockquote><p><br></p>' },
		{ label: "richYellowBlock", alias: "warning", keywords: "yellow callout 黄色 高亮", action: "insertHTML", argument: '<blockquote data-rich-highlight="warning"><p data-slash-insert><br></p></blockquote><p><br></p>' },
		{ label: "richCollapse", alias: "collapse", keywords: "collapse details zhedie 折叠", action: "insertHTML", argument: `<p><br></p><div data-rich-collapse=""><p data-rich-summary data-slash-insert>${t("richCollapse")}</p><div data-rich-collapse-body><p><br></p></div></div><p><br></p>` },
		{ label: "richMath", alias: "math", keywords: "math latex formula 公式 数学", action: "math" },
		{ label: "richLinkCard", alias: "card", keywords: "card link 卡片 链接", action: "card" },
		{ label: "wikiAddLink", alias: "link", keywords: "url link 链接", action: "link" },
		{ label: "richTable", alias: "bg", keywords: "table bg biaoge 表格", action: "insertHTML", argument: `<table><thead><tr><th data-slash-insert>${t("richColumn")} 1</th><th>${t("richColumn")} 2</th></tr></thead><tbody><tr>${gutterHtml()}<td>…</td><td>…</td></tr></tbody></table><p><br></p>` },
		{ label: "richList", alias: "lb", keywords: "bullet list lb liebiao wxlb wuxuliebiao 列表 无序列表", action: "insertUnorderedList" },
		{ label: "richOrderedList", alias: "bh", keywords: "number ordered bh bianhao yxlb youxuliebiao 编号 有序列表", action: "insertOrderedList" },
		{ label: "richTaskList", alias: "rw", keywords: "task todo checkbox rw rwlb renwu renwuliebiao 任务", action: "insertHTML", argument: '<ul><li><input type="checkbox"><span data-slash-insert> </span></li></ul><p><br></p>' },
		{ label: "richQuote", alias: "yy", keywords: "quote yy yinyong 引用", action: "formatBlock", argument: "blockquote" },
		{ label: "richTocInsert", alias: "ml", keywords: "toc table of contents outline ml mulu 目录 大纲", action: "toc" },
		{ label: "richDivider", alias: "fgx", keywords: "divider horizontal rule fgx fengexian 分隔线", action: "insertHTML", argument: "<hr><p><br></p>" },
			{ label: "richImage", alias: "tp", keywords: "image photo upload tp tupian 图片", action: "image" },
		{ label: "richWikiLink", alias: "sl", keywords: "wiki link document sl shuanglian 链接 双链 文档", action: "wikiLink" },
			{ label: "wikiMentionDate", alias: "date", keywords: "date mention riqi 日期", action: "insertText", get argument() { return new Date().toLocaleDateString("sv-SE"); } }, // read at insert time, not render time
	] as const;
	// Palette order: the six shapes people reach for most stay above the fold; H4–H6 live in the
	// toolbar overflow menu instead of taking a row here (both entries insert the same blocks).
	const paletteOrder = ["zw", "bt1", "bt2", "bt3", "lb", "bh", "rw", "link", "dmk"];
	const wikiOrder = [...paletteOrder, "tp", "bg", "yy", "fgx", "date", "sl", "ml", "glk", "tip", "warning", "collapse", "card", "math"];
	const items = wiki ? allItems.filter(item => wikiOrder.includes(item.alias)).sort((a, b) => wikiOrder.indexOf(a.alias) - wikiOrder.indexOf(b.alias)) : allItems.filter(item => !["date", "sl", "ml"].includes(item.alias));
	const icons = { richMath: <FiCode />, richGreenBlock: wiki ? <LuLightbulb /> : <FiSquare />, richYellowBlock: wiki ? <LuTriangleAlert /> : <FiSquare />, richCollapse: wiki ? <LuChevronsUpDown /> : <FiSquare />, richLinkCard: wiki ? <LuPanelTop /> : <FiLink />, wikiAddLink: <FiLink />, wikiMentionDate: <FiCalendar />, richImage: <FiImage />, richWikiLink: <FiLink />, richHighlightBlock: wiki ? <LuInfo /> : <FiSquare />, richHeading: <FiType />, richParagraph: <FiType />, richCodeBlock: <FiCode />, richTable: <WikiTableIcon />, richList: <FiList />, richOrderedList: wiki ? <LuListOrdered /> : <FiList />, richTaskList: <FiCheckSquare />, richQuote: <WikiQuoteIcon />, richDivider: <FiMinus />, richTocInsert: <LuTableOfContents /> };
	const itemLabel = (item: typeof items[number]) => item.label === "richHeading" ? `${t(item.label)} ${"argument" in item ? item.argument.slice(1) : ""}` : t(item.label);
	const isBlock = (item: typeof items[number]) => item.action === "insertHTML" || item.action === "toc";
	const hints: Record<string, string> = { date: "@", zw: "", bt1: "#", bt2: "##", bt3: "###", lb: "-", bh: "1.", rw: "[]", yy: ">", dmk: "```", glk: ":::", bg: "3 × 3", fgx: "---", tp: "![]", sl: "[[", ml: "" };
	const help: Record<string, Parameters<typeof t>[0]> = { tip: "wikiInsertTip", warning: "wikiInsertWarning", collapse: "wikiInsertCollapse", card: "wikiInsertCard", link: "wikiInsertLink", date: "wikiInsertDate", zw: "wikiInsertParagraph", bt1: "wikiInsertH1", bt2: "wikiInsertH2", bt3: "wikiInsertH3", bt4: "wikiInsertHeading", bt5: "wikiInsertHeading", bt6: "wikiInsertHeading", lb: "wikiInsertList", bh: "wikiInsertOrdered", rw: "wikiInsertTask", yy: "wikiInsertQuote", dmk: "wikiInsertCode", glk: "wikiInsertCallout", bg: "wikiInsertTable", fgx: "wikiInsertDivider", tp: "wikiInsertImage", sl: "wikiInsertLink", ml: "wikiInsertToc" };
	const matches = items.filter((item) => `${itemLabel(item)} ${item.keywords}`.toLowerCase().includes(menu?.query.toLowerCase() ?? "")).sort((a, b) => wiki ? wikiOrder.indexOf(a.alias) - wikiOrder.indexOf(b.alias) : Number(isBlock(a)) - Number(isBlock(b)));
	const prepareInsert = () => {
		const selection = window.getSelection();
		if (selection?.rangeCount && root.current?.contains(selection.anchorNode)) savedRange.current = selection.getRangeAt(0).cloneRange();
	};
	const restoreInsert = () => {
		if (!root.current || readOnly) return false;
		root.current.focus({ preventScroll: true });
		const range = savedRange.current && root.current.contains(savedRange.current.startContainer) ? savedRange.current : document.createRange();
		if (!savedRange.current || !root.current.contains(range.startContainer)) { range.selectNodeContents(root.current); range.collapse(false); }
		const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return true;
	};
	const insertToolbar = (id: string, dimensions?: { columns: number; rows: number }, language?: string, popupAnchor?: Pick<DOMRect, "left" | "bottom">) => {
		if (!restoreInsert()) return;
		if (id === "bg" && !dimensions) {
			const rect = popupAnchor ?? savedRange.current?.getBoundingClientRect();
			setInsertPopup({ kind: "table", x: insertPopup?.x ?? rect?.left ?? 16, y: insertPopup?.y ?? (rect?.bottom ?? 80) + 6 }); return;
		}
		setInsertPopup(null);
		rememberInsertion(id);
		if (["glk", "tip", "warning"].includes(id)) {
			const node = window.getSelection()?.anchorNode;
			const existing = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("blockquote[data-rich-highlight]");
			if (existing && root.current?.contains(existing)) {
				const clone = existing.cloneNode(true) as HTMLElement; clone.dataset.richHighlight = id === "glk" ? "note" : id;
				// Remove the quote context first: Chromium otherwise nests the replacement
				// inside the old callout. Both edits remain in native undo history.
				const range = document.createRange(); range.selectNodeContents(existing); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
				document.execCommand("outdent");
				command("insertHTML", clone.outerHTML); prepareInsert(); return;
			}
		}
		if (id === "math") { mathRange.current = window.getSelection()?.getRangeAt(0).cloneRange() ?? null; setMathInput({ source: "", display: true }); return; }
		if (id === "card") { cardRange.current = window.getSelection()?.getRangeAt(0).cloneRange() ?? null; setCardOpen(true); return; }
		if (id === "link") { linkRange.current = window.getSelection()?.getRangeAt(0).cloneRange() ?? null; setLinkInput(""); return; }
		if (id === "bg" && dimensions) {
			command("insertHTML", `<table><thead><tr>${Array.from({ length: dimensions.columns }, (_, i) => `<th ${i === 0 ? 'data-slash-insert' : ''}>${t("richColumn")} ${i + 1}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: dimensions.rows - 1 }, () => `<tr>${gutterHtml()}${'<td><br></td>'.repeat(dimensions.columns)}</tr>`).join('')}</tbody></table><p><br></p>`);
		} else if (id === "dmk") command("insertHTML", `<pre><code data-slash-insert class="language-${language || 'plaintext'}">${language === 'mermaid' ? 'flowchart LR\n  A --> B' : '<br>'}</code></pre><p><br></p>`);
		else {
			// H4–H6 are not in the palette but the toolbar overflow still inserts them.
			const item = items.find(item => item.alias === id) ?? allItems.find(item => item.alias === id); if (!item) return;
			if (item.action === "card" || item.action === "link" || item.action === "math") return;
			if (item.action === "image") { imageRange.current = window.getSelection()?.getRangeAt(0).cloneRange() ?? null; imageInput.current?.click(); return; }
			if (item.action === "toc") { insertToc(); return; }
			if (item.action === "wikiLink") { command("insertText", "[["); const range = window.getSelection()?.getRangeAt(0).cloneRange(); if (range && range.startOffset >= 2) range.setStart(range.startContainer, range.startOffset - 2); linkRange.current = range ?? null; setLinkInput("[["); return; }
			command(item.action, "argument" in item ? item.argument : undefined);
		}
		const target = root.current?.querySelector("[data-slash-insert]");
		if (target) { target.removeAttribute("data-slash-insert"); const range = document.createRange(); range.selectNodeContents(target); range.collapse(true); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); update(); }
		prepareInsert();
	};
	const styledSelection = (styles: string) => {
		const selection = window.getSelection();
		if (!selection?.rangeCount) return;
		const collapsed = selection.isCollapsed;
		const span = document.createElement("span"); span.style.cssText = styles; span.dataset.richSelection = "";
		if (collapsed) { span.dataset.richTyping = ""; span.textContent = "\u200b"; } else span.append(selection.getRangeAt(0).cloneContents());
		command("insertHTML", span.outerHTML);
		const inserted = root.current?.querySelector<HTMLElement>("[data-rich-selection]");
		if (inserted) { inserted.removeAttribute("data-rich-selection"); const range = document.createRange(); range.selectNodeContents(inserted); if (collapsed) range.collapse(false); selection.removeAllRanges(); selection.addRange(range); prepareInsert(); update(); }
	};
	// One replacement path for both painting and clearing: inline declarations are
	// stripped or applied element by element, block declarations are replaced wholesale.
	const paintBlocks = (sample: FormatSample | null) => {
		const selection = window.getSelection();
		if (!selection?.rangeCount) return;
		const collapsed = selection.isCollapsed;
		const start = selection.getRangeAt(0).startContainer, end = selection.getRangeAt(0).endContainer;
		const within = (node: Node | null) => node instanceof HTMLElement ? node : node?.parentElement ?? null;
		const first = within(start)?.closest<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote"), last = within(end)?.closest<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote");
		if (!first || !last || !root.current?.contains(first)) return;
		// Collect every block between the two ends so a cross-block selection paints each one.
		const blocks: HTMLElement[] = [];
		for (const candidate of root.current.querySelectorAll<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote")) {
			// The tail placeholder and editor chrome are not document content, and a table's
			// own wrapper is not a paintable block.
			if (candidate.hasAttribute("data-rich-tail") || candidate.closest("[data-rich-ui], table[contenteditable=false]")) continue;
			blocks.push(candidate);
		}
		const startIndex = blocks.indexOf(first), endIndex = blocks.indexOf(last);
		const targets = collapsed || startIndex < 0 || endIndex < startIndex ? [first] : blocks.slice(startIndex, endIndex + 1);
		// Build every replacement before touching the document: replacing nodes one at a
		// time invalidates the references still held for the remaining targets.
		const replacements = targets.map(block => {
			const clone = block.cloneNode(true) as HTMLElement;
			clone.removeAttribute("style");
			clone.querySelectorAll<HTMLElement>("[style]").forEach(el => el.removeAttribute("style"));
			// Remove semantic formatting too; clearing CSS alone leaves bold/highlight behind.
			clone.querySelectorAll("strong,b,em,i,u,s,strike,del,mark").forEach(el => el.replaceWith(...el.childNodes));
			const style = sample ? paintedBlockStyle(sample) : "";
			if (style) clone.setAttribute("style", style);
			if (style) clone.dataset.richFormat = "";
			else clone.removeAttribute("data-rich-format");
			if (sample && Object.keys(sample.inline).length) {
				for (const child of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
					if (child !== clone && child.tagName !== "SPAN") continue;
					for (const [key, value] of Object.entries(sample.inline)) child.style.setProperty(key as InlineKey, value);
				}
			}
			return clone;
		});
		for (const [index, block] of targets.entries()) {
			const clone = replacements[index];
			if (!block.isConnected) continue;
			const range = document.createRange(); range.selectNode(block); selection.removeAllRanges(); selection.addRange(range);
			if (sample && canReplaceBlockTag(block.tagName, sample.tag)) insertTagged(clone, sample.tag); else command("insertHTML", clone.outerHTML);
		}
		prepareInsert(); update();
	};
	// `insertHTML` unwraps or keeps the outer element depending on Chromium's mood; writing
	// the replacement node directly makes an intent-to-promote block an actual heading.
	const insertTagged = (clone: HTMLElement, tag: string) => {
		const selection = window.getSelection();
		if (!selection?.rangeCount) return;
		const range = selection.getRangeAt(0);
		const replacement = document.createElement(tag);
		replacement.innerHTML = clone.innerHTML;
		for (const { name, value } of [...clone.attributes]) replacement.setAttribute(name, value);
		range.deleteContents(); range.insertNode(replacement);
		const after = document.createRange(); after.selectNodeContents(replacement); after.collapse(false);
		selection.removeAllRanges(); selection.addRange(after);
	};
	const format = (action: string, argument?: string) => {
		const selection = window.getSelection(); const node = selection?.anchorNode;
		const element = node instanceof HTMLElement ? node : node?.parentElement;
		// Aligning inside a table selects the whole column's cells; anywhere else the
		// generic block path below applies. Fall through when the cell cannot be located.
		if (action === "text-align" && selectedCell() && ["left", "center", "right"].includes(argument ?? "")) {
			const cell = selectedCell()!, located = locateCell(cell);
			if (located && located.column >= 0) { editTable(argument as "left" | "center" | "right", located); return; }
		}
		if (action === "task") { insertToolbar("rw"); return; }
		if (action === "paint") {
			// Clicking an armed painter cancels it; clicking again with nothing sampled arms one.
			if (painterRef.current) { setPainter(argument === "sticky" ? { ...painterRef.current, sticky: true } : null); return; }
			const sampled = sampleAt();
			if (sampled) setPainter({ sampled, sticky: argument === "sticky" });
			return;
		}
		if (action === "clear") {
			// Capture the target before the native command runs: `removeFormat` rewrites the
			// selection, so resolving the block afterwards can land on the wrong node.
			const selection = window.getSelection();
			const anchor = selection?.anchorNode;
			const target = (anchor instanceof HTMLElement ? anchor : anchor?.parentElement)?.closest<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote");
			// Two stages on purpose: the native command handles inline cleanup well, the
			// block stage below removes block-level declarations it cannot reach.
			command("removeFormat");
			if (target && root.current?.contains(target)) {
				target.removeAttribute("style");
				target.removeAttribute("data-rich-format");
				target.querySelectorAll<HTMLElement>("[style]").forEach(el => el.removeAttribute("style"));
				update(); prepareInsert();
			}
			return;
		}
		if (action === "highlight") { const color = TEXT_HIGHLIGHT_COLORS.find(c => c.name === argument); command("hiliteColor", color?.hex ?? "transparent"); return; }
		if (["font-size", "color"].includes(action)) { styledSelection(`${action}: ${argument}`); return; }
		if (action === "line-height" || action === "text-align" || action === "plainBlock") {
			const block = element?.closest<HTMLElement>(action === "plainBlock" ? "blockquote,details,div[data-rich-collapse],figure" : "p,h1,h2,h3,h4,h5,h6,li,td,th");
			if (!block || !root.current?.contains(block)) return;
			const clone = block.cloneNode(true) as HTMLElement;
			if (action === "plainBlock" && block.tagName === "BLOCKQUOTE") {
				const range = document.createRange(); range.selectNodeContents(block); selection?.removeAllRanges(); selection?.addRange(range); command("outdent"); prepareInsert(); return;
			}
			if (action === "plainBlock") {
				clone.querySelectorAll("[data-rich-ui]").forEach(el => el.remove());
				clone.querySelectorAll("[data-rich-summary], [data-rich-collapse-body]").forEach(el => { el.removeAttribute("data-rich-summary"); el.removeAttribute("data-rich-collapse-body"); el.removeAttribute("hidden"); });
				clone.querySelectorAll("summary").forEach(summary => { const p = document.createElement("p"); p.textContent = summary.textContent; summary.replaceWith(p); });
			}
			else { clone.style.setProperty(action, argument!); clone.dataset.richFormat = ""; }
			const range = document.createRange();
			if (action === "plainBlock") {
				// Start/end in neutral paragraphs. Chromium otherwise preserves the
				// selected DIV's attributes when replacing its last editable content.
				const before = document.createElement("p"), after = document.createElement("p");
				before.append(document.createElement("br")); after.append(document.createElement("br"));
				block.before(before); block.after(after); range.setStart(before, 0); range.setEnd(after, after.childNodes.length);
			} else range.selectNode(block);
			selection?.removeAllRanges(); selection?.addRange(range);
			command("insertHTML", action === "plainBlock" ? clone.innerHTML : clone.outerHTML); prepareInsert(); return;
		}
		command(action, argument); prepareInsert();
	};
	const commands = new RichCommands({
		editable: () => !readOnly,
		captureSelection: prepareInsert, restoreSelection: restoreInsert, execute: format,
		insert: id => insertToolbar(id),
		color: variable => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
		armed: () => painterRef.current !== null,
		sticky: () => painterRef.current?.sticky ?? false,
	});
	const inspectSlash = (resetActive = true) => {
		if (readOnly) return closeMenu();
		const selection = window.getSelection();
		if (!selection?.isCollapsed || !selection.anchorNode || !root.current?.contains(selection.anchorNode)) return closeMenu();
		const node = selection.anchorNode;
		if (node.nodeType !== Node.TEXT_NODE || node.parentElement?.closest("pre, code, a, li, [contenteditable=false]")) return closeMenu();
		const before = node.textContent?.slice(0, selection.anchorOffset) ?? "";
		const match = (wiki ? /\/([\p{L}\p{N}]{0,32})$/u : /\/([^\s/]{0,32})$/).exec(before);
		if (!match) return closeMenu();
		const range = selection.getRangeAt(0).cloneRange();
		range.setStart(node, selection.anchorOffset - match[1].length - 1);
		// Check the entire logical block, not only this text node: bold/link
		// spans split a paragraph into several nodes but do not start a new one.
		const block = node.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, li, td, th, div");
		if (!block || !root.current.contains(block)) return closeMenu();
		const prefix = document.createRange();
		prefix.selectNodeContents(block);
		prefix.setEnd(range.startContainer, range.startOffset);
		const preceding = prefix.cloneContents();
		if ((wiki ? !!preceding.textContent && !/\s$/.test(preceding.textContent) : !!preceding.textContent) || preceding.querySelector("br, img, input, hr, video, audio")) return closeMenu();
		slashRange.current = range;
		const rect = range.getBoundingClientRect();
		setMenu({ query: match[1], x: Math.max(8, Math.min(rect.left, window.innerWidth - (wiki ? 308 : 328))), y: rect.bottom + 6 });
		if (resetActive) setActive(0);
	};
	useEffect(() => {
		if (!menu) return;
		const scroll = (event: Event) => {
			if (event.target instanceof Element && event.target.closest(".fp-slash-menu")) return;
			const rect = slashRange.current?.getBoundingClientRect();
			// Typing at the bottom can scroll the caret into view after input.
			// Keep the Wiki menu attached to that caret instead of closing it.
			if (wiki && rect && rect.bottom >= 0 && rect.top <= window.innerHeight) inspectSlash(false);
			else closeMenu();
		};
		window.addEventListener("scroll", scroll, true); window.addEventListener("resize", closeMenu);
		return () => { window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", closeMenu); };
	}, [!!menu]);
	useLayoutEffect(() => {
		if (!menu || !popup.current || !slashRange.current) return;
		const rect = slashRange.current.getBoundingClientRect(), height = popup.current.offsetHeight;
		popup.current.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popup.current.offsetWidth - 8))}px`;
		popup.current.style.top = `${Math.max(8, rect.bottom + 6 + height <= window.innerHeight - 8 ? rect.bottom + 6 : rect.top - height - 6)}px`;
	}, [menu]);
	useLayoutEffect(() => {
		const option = document.getElementById(`fp-slash-option-${active}`);
		const popup = wiki ? option?.parentElement : option?.closest<HTMLElement>(".fp-slash-menu");
		if (option && popup) {
			if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop;
			else if (option.offsetTop + option.offsetHeight > popup.scrollTop + popup.clientHeight) popup.scrollTop = option.offsetTop + option.offsetHeight - popup.clientHeight;
		}
	}, [active, menu?.query]);
	const insert = (index: number) => {
		const range = slashRange.current;
		const item = matches[index];
		if (readOnly || !item || !range || !root.current?.contains(range.startContainer)) return closeMenu();
		root.current.focus();
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		// Deleting the slash text can leave an empty block whose caret rect is all zeros.
		const popupAnchor = range.getBoundingClientRect();
		closeMenu();
		document.execCommand("delete");
		if (wiki || host) { prepareInsert(); insertToolbar(item.alias, undefined, undefined, popupAnchor); return; }
		if (item.action === "card" || item.action === "link" || item.action === "math") { prepareInsert(); insertToolbar(item.alias); update(); return; }
		if (item.action === "image") { imageRange.current = selection?.getRangeAt(0).cloneRange() ?? null; imageInput.current?.click(); update(); return; }
		if (item.action === "wikiLink") { linkRange.current = selection?.getRangeAt(0).cloneRange() ?? null; setLinkInput("[["); update(); return; }
		if (item.action === "toc") { insertToc(); return; }
		if (wiki && item.alias === "bg") command("insertHTML", `<table><thead><tr>${[1, 2, 3].map(n => `<th ${n === 1 ? "data-slash-insert" : ""}>${t("richColumn")} ${n}</th>`).join("")}</tr></thead><tbody>${[1, 2].map(() => `<tr>${gutterHtml()}<td>…</td><td>…</td><td>…</td></tr>`).join("")}</tbody></table><p><br></p>`);
		else command(item.action, "argument" in item ? item.argument : undefined);
		// Inserted composite blocks carry an explicit caret target; formatBlock retains its native selection.
		const target = root.current.querySelector("[data-slash-insert]");
		if (target) {
			target.removeAttribute("data-slash-insert");
			const caret = document.createRange();
			caret.selectNodeContents(target);
			caret.collapse(true);
			selection?.removeAllRanges();
			selection?.addRange(caret);
			update();
		}
	};
	const toggleHighlight = (color: typeof TEXT_HIGHLIGHT_COLORS[number]) => {
		const range = highlightSelection();
		if (!range || !root.current) return;
		const walker = document.createTreeWalker(root.current, NodeFilter.SHOW_TEXT);
		const colors: string[] = [];
		let node: Node | null;
		while ((node = walker.nextNode())) {
			if (!node.textContent || !range.intersectsNode(node)) continue;
			if (range.endContainer === node && range.endOffset === 0 || range.startContainer === node && range.startOffset === node.textContent.length) continue;
			let element = node.parentElement, background = "";
			while (element && element !== root.current) {
				if (element.style.backgroundColor && element.style.backgroundColor !== "transparent") { background = element.style.backgroundColor; break; }
				element = element.parentElement;
			}
			colors.push(background);
		}
		command("hiliteColor", colors.length && colors.every(value => value === color.rgb || value === color.hex) ? "transparent" : color.hex);
	};
	const insertLink = (address: string, internal = false) => {
		const range = linkRange.current;
		if (readOnly || !range || !root.current?.contains(range.startContainer)) return;
		if (!internal && !/^(https?:\/\/|mailto:|#|\.?\.?\/)/i.test(address)) { setImageError(t("wikiInvalidLink")); return; }
		const a = document.createElement("a"); a.setAttribute("href", internal ? `#wiki=${encodeURIComponent(address)}` : address);
		a.textContent = range.toString() && range.toString() !== "[[" ? range.toString() : address;
		root.current.focus(); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
		command("insertHTML", a.outerHTML); setLinkInput(null);
	};
	const markdownShortcut = () => {
		if (!wiki || readOnly) return false;
		const selection = window.getSelection(), node = selection?.anchorNode;
		if (!selection?.isCollapsed || !node || !root.current?.contains(node) || node.parentElement?.closest("pre, code, a, [contenteditable=false]")) return false;
		const block = node.parentElement?.closest("p, div");
		if (!block || block === root.current) return false;
		const range = selection.getRangeAt(0).cloneRange(); range.setStart(block, 0);
		const text = range.toString(), heading = /^(#{1,6})$/.exec(text);
		const item = allItems.find(item => item.alias === ({ "-": "lb", "*": "lb", "1.": "bh", "[]": "rw", "[ ]": "rw", ">": "yy", "```": "dmk", "---": "fgx", ":::": "glk" } as Record<string, string>)[text]);
		if (!heading && !item) return false;
		selection.removeAllRanges(); selection.addRange(range); document.execCommand("delete");
		if (heading) {
			// Chromium can leave the caret in a preceding code block after formatting
			// an empty paragraph. Resolve only the originating block's replacement.
			const parent = block.parentElement;
			const index = parent ? Array.from(parent.childNodes).indexOf(block) : -1;
			command("formatBlock", `h${heading[1].length}`);
			const replacement = parent?.childNodes[index];
			if (replacement instanceof HTMLElement && replacement.tagName === `H${heading[1].length}`) {
				const caret = document.createRange(); caret.selectNodeContents(replacement); caret.collapse(true);
				selection.removeAllRanges(); selection.addRange(caret);
			}
		}
		else if (item) command(item.action, "argument" in item ? item.argument : undefined);
		const target = root.current.querySelector("[data-slash-insert]");
		if (target) { target.removeAttribute("data-slash-insert"); range.selectNodeContents(target); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
		closeMenu(); update(); return true;
	};

	return <div className="fp-rich-editor" onScrollCapture={(event) => { if (!(event.target as HTMLElement).closest(".fp-slash-menu")) { if (menu) inspectSlash(false); } }}>
		{wiki?.toolbar?.host && createPortal(<WikiToolbar readOnly={readOnly} focused={!!wiki.width?.focused} onWidth={wiki.width?.onToggle ?? (() => {})} items={items.map(item => ({ id: item.alias, label: item.label === "richHeading" ? `${t("richHeading")} ${"argument" in item ? item.argument.slice(1) : ""}` : itemLabel(item), hint: hints[item.alias] ?? "", help: t(help[item.alias] ?? item.label), icon: item.label === "richHeading" ? <span className="wiki-heading-icon">{`H${"argument" in item ? item.argument.slice(1) : ""}`}</span> : icons[item.label] }))} editor={root.current} commands={commands} painter={!!painter} painterDisabled={samplable === false} onPaint={sticky => format("paint", sticky ? "sticky" : undefined)} />, wiki.toolbar.host)}
		{diagrams.map(({ host, code }, index) => createPortal(<MermaidDiagram code={code} />, host, String(index)))}
		{insertPopup && !readOnly && <WikiInsertPopover popup={insertPopup} onClose={() => { setInsertPopup(null); restoreInsert(); }}>
			<TableSizePicker onInsert={(columns, rows) => insertToolbar("bg", { columns, rows })} />
		</WikiInsertPopover>}
		{!wiki?.toolbar && !readOnly && <RichFormattingToolbar compact={compact} commands={commands} onFold={foldSelection} painter={!!painter} painterDisabled={samplable === false} onPaint={sticky => format("paint", sticky ? "sticky" : undefined)} />}
		{cardOpen && <RichLinkCardDialog onClose={() => setCardOpen(false)} onInsert={async (card, signal) => {
			const range = cardRange.current, editor = root.current;
			if (!range || !editor?.contains(range.startContainer) || readOnlyRef.current) throw Error();
			let path: string | undefined;
			if (card.imageData) path = await uploadImageData(card.imageData, signal);
			signal.throwIfAborted();
			if (!root.current?.contains(range.startContainer) || readOnlyRef.current) throw Error();
			const figure = document.createElement("figure"); figure.dataset.richCard = "1";
			if (path) { const image = document.createElement("img"); image.src = path; image.alt = ""; figure.append(image); }
			const link = document.createElement("a"); link.setAttribute("href", card.url); link.textContent = card.title; const p = document.createElement("p"); p.textContent = card.description; figure.append(link, p);
			root.current.focus(); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); command("insertHTML", "<p><br></p>" + figure.outerHTML + "<p><br></p>");
		}} />}


		{uploading && <div className="fp-notice" role="status">{t("richImageUploading")}</div>}
		{imageError && <div className="fp-notice" role="alert">{imageError}</div>}
		{wiki?.ask && floating && linkInput === null && createPortal(<div ref={floatingToolbar} className="wiki-format-popover" role="toolbar" aria-label={t("richFormatToolbar")} style={{ left: floating.x, top: floating.y }} onMouseDown={e => e.preventDefault()}>
			<button className="wiki-ask-selection" onClick={() => { wiki.ask!(window.getSelection()?.toString() ?? ""); setFloating(null); }}>{t("wikiAskPi")}</button>
		</div>, document.querySelector(".wiki-document-dialog") ?? document.body)}
		<input ref={imageInput} type="file" accept="image/*" hidden onChange={event => { const image = event.target.files?.[0], range = imageRange.current; if (image && range && root.current?.contains(range.startContainer)) { root.current.focus(); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); void pasteImage(image); } event.target.value = ""; }} />
		{mathInput !== null && <WikiReadingDialog title={t("richMath")} onClose={() => setMathInput(null)}>
			<form className="rich-math-form" onSubmit={event => {
				event.preventDefault();
				const range = mathRange.current;
				if (readOnly || !range || !root.current?.contains(range.startContainer)) return;
				root.current.focus(); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
				command("insertHTML", createMath(mathInput.source.trim(), mathInput.display).outerHTML);
				setMathInput(null);
			}}>
				<label>{t("richMathSource")}<textarea autoFocus rows={5} value={mathInput.source} onChange={event => setMathInput({ ...mathInput, source: event.target.value })} /></label>
				<label><input type="checkbox" checked={mathInput.display} onChange={event => setMathInput({ ...mathInput, display: event.target.checked })} />{t("richMathDisplay")}</label>
				<p>{t("richMathHelp")}</p>
				<button type="submit" disabled={!mathInput.source.trim()}>{t("save")}</button>
			</form>
		</WikiReadingDialog>}
		{linkInput !== null && <WikiReadingDialog title={t("wikiAddLink")} onClose={() => setLinkInput(null)}><form className="wiki-link-form" onSubmit={event => { event.preventDefault(); insertLink(linkInput); }}><input aria-label={t("wikiLinkAddress")} placeholder={t("wikiLinkAddress")} value={linkInput} onChange={e => setLinkInput(e.target.value)} /><button type="submit" disabled={!linkInput.trim() || linkInput.startsWith("[[")}>{t("wikiInsertLinkAction")}</button></form>{linkInput.startsWith("[[") && <div className="wiki-link-results">{(wiki?.links?.paths ?? []).filter((path: string) => /\.(md|markdown|mdown)$/i.test(path) && path.toLowerCase().includes(linkInput.slice(2).toLowerCase())) .slice(0, 30).map((path: string) => <button key={path} onClick={() => insertLink(path, true)}>{path}</button>)}</div>}</WikiReadingDialog>}
		{/* The menu is chrome, not content: a press on it must neither move the caret nor
		 *  count as a click the editor turns into "select" — which a portal inside the
		 *  dialog fails to prevent by itself. Modelled on Yuque: the counts are fields, so
		 *  "insert 2 rows" is one gesture instead of two clicks, and the destructive block
		 *  is separated and stays last. */}
		{tableMenu && !readOnly && createPortal(<div className="fp-table-menu" role="menu" aria-label={t("richTableTools")} style={{ left: Math.max(8, Math.min(tableMenu.x, window.innerWidth - 300)), top: Math.max(8, Math.min(tableMenu.y, window.innerHeight - 440)) }} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}>
			{(() => {
				const rows = tableMenu.table.rows;
				const bodyCount = Array.from(rows).filter(row => !isHeaderRow(row)).length;
				const selectedRows = (tableMenu.selectedRows ?? [tableMenu.row]).filter(index => !isHeaderRow(rows[index]));
				const rowOk = selectedRows.length > 0 && selectedRows.length < bodyCount;
				const columnOk = (tableMenu.selectedColumns?.length ?? 1) < dataCells(rows[tableMenu.row]).length;
				const count = (id: "row" | "column", value: string) => <input key={id} className="fp-table-count" inputMode="numeric" aria-label={t(id === "row" ? "richRowCount" : "richColumnCount")} value={value} onChange={event => setInsertCount(current => ({ ...current, [id]: event.target.value.replace(/\D/g, "").slice(0, 2) }))} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} />;
				const unit = (id: "row" | "column") => <span className="fp-table-unit">{t(id === "row" ? "richRowUnit" : "richColumnUnit")}</span>;
				const insert = (label: Parameters<typeof t>[0], action: TableAction, icon: React.ReactNode, id: "row" | "column") => <button type="button" role="menuitem" key={action} onClick={() => editTable(action, undefined, insertCount)}><span className="fp-table-icon" aria-hidden="true">{icon}</span>{t(label)}{count(id, insertCount[id])}{unit(id)}</button>;
				const entry = (label: Parameters<typeof t>[0], action: TableAction, disabled = false, reason?: string, icon?: React.ReactNode) => <button type="button" role="menuitem" key={action} disabled={disabled} title={disabled ? reason : undefined} onClick={() => editTable(action)}>{icon && <span className="fp-table-icon" aria-hidden="true">{icon}</span>}{t(label)}</button>;
				return <>
					{insert("richInsertRowAbove", "rowAbove", <FiArrowUp aria-hidden="true" />, "row")}
					{insert("richInsertRowBelow", "rowBelow", <FiArrowDown aria-hidden="true" />, "row")}
					{insert("richInsertColumnLeft", "columnLeft", <FiArrowLeft aria-hidden="true" />, "column")}
					{insert("richInsertColumnRight", "columnRight", <FiArrowRight aria-hidden="true" />, "column")}
					<button className="fp-table-number" type="button" role="menuitem" onClick={() => editTable("numberRows")} aria-disabled={!Number.isInteger(Number(numberStart)) || Number(numberStart) < 1 || Number(numberStart) > bodyCount}>
						<span className="fp-table-icon" aria-hidden="true"><FiList /></span>{t("richNumberFrom")}<input className="fp-table-count" aria-label={t("richNumberStart")} inputMode="numeric" value={numberStart} onChange={event => setNumberStart(event.target.value.replace(/\D/g, "").slice(0, 6))} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} /><span>{t("richNumberRows")}</span>
					</button>
					{entry("richInsertSequence", "numberColumn", false, undefined, <FiList />)}
					<hr role="separator" />
					{entry("richRemoveRow", "removeRow", !rowOk, t("richKeepOneRow"))}
					{entry("richRemoveColumn", "removeColumn", !columnOk, t("richKeepOneColumn"))}
					{entry("richRemoveTable", "removeTable")}
					<hr role="separator" />
					{entry("richClearCells", "clearCells")}
				</>;
			})()}
		</div>, document.querySelector(".wiki-document-dialog") ?? document.body)}
		{menu && !readOnly && createPortal(<div ref={popup} className={`fp-slash-menu ${wiki ? `wiki-slash-menu ${menu.query ? "" : "wiki-slash-grid"}` : ""}`} style={{ left: menu.x, top: menu.y }}>
			{wiki && !menu.query && recentInsertions.some(id => items.some(item => item.alias === id)) && <div className="wiki-insert-recent"><span>{t("wikiRecentlyUsed")}</span><div>{recentInsertions.map(id => {
				const index = matches.findIndex(item => item.alias === id), item = matches[index];
				return item && <button type="button" key={id} onMouseDown={event => event.preventDefault()} onClick={() => insert(index)}>{itemLabel(item)}</button>;
			})}</div></div>}
			<div className="fp-slash-options" role="listbox" aria-label={t("richInsertMenu")}>
			{matches.length ? matches.map((item, index) => <Fragment key={item.alias}>
				{wiki && !menu.query && [12, 19].includes(index) && <div className="wiki-palette-section" role="presentation">{t(index === 12 ? "richBlocksGroup" : "wikiInsertContentBlocks")}</div>}
				{!wiki && (index === 0 || isBlock(item) !== isBlock(matches[index - 1])) && <div className="fp-slash-group" role="presentation">{t(isBlock(item) ? "richBlocksGroup" : "richTextGroup")}</div>}
				<button className={wiki && !menu.query ? (index < 12 ? "wiki-palette-format" : `wiki-palette-card wiki-palette-${item.alias}`) : undefined} type="button" role="option" aria-label={itemLabel(item)} title={`${itemLabel(item)} · ${t(help[item.alias] ?? item.label)}`} aria-selected={index === active} id={`fp-slash-option-${index}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => insert(index)}>
					<span className="fp-slash-icon" aria-hidden="true">{wiki && item.label === "richHeading" ? <span className="wiki-heading-icon">H{"argument" in item ? item.argument.slice(1) : ""}</span> : icons[item.label]}</span><span className="fp-slash-label">{itemLabel(item)}{wiki && <small>{t(help[item.alias] ?? item.label)}</small>}</span><kbd aria-hidden="true">{wiki ? hints[item.alias] : `/${item.alias}`}</kbd>
				</button></Fragment>) : <span className="wiki-slash-empty">{t(wiki ? "wikiNoInsertResults" : "richNoElements")}</span>}
			</div>{wiki && <footer>{t("wikiInsertKeys")}</footer>}
		</div>, document.querySelector(".wiki-document-dialog") ?? document.body)}
		<div className="fp-markdown msg-text">
			<div className="fp-markdown-zoom">
				<div ref={root} className="md fp-rich-document" role="textbox" aria-label={t("richEditMarkdown")} aria-multiline="true"
					contentEditable={!readOnly} suppressContentEditableWarning spellCheck={false} tabIndex={-1}
					aria-modal={!!tableMenu}
					
					onContextMenu={(event) => {
						if (readOnly) return;
						const cell = (event.target as HTMLElement).closest<HTMLTableCellElement>("th, td");
						if (!cell || !root.current?.contains(cell)) return;
						event.preventDefault();
						const located = locateCell(cell);
						if (!located) return;
						// The header's gutter is alignment chrome, not a target: it names no column
						// and no deletable row, so it opens nothing.
						if (isGutter(cell) && isHeaderRow(cell.parentElement as HTMLTableRowElement | null)) return;
						// The press already froze what the menu acts on; the release that follows
						// it must read the same state instead of the caret it just collapsed.
						const frozen = pressedTarget.current?.table === located.table ? pressedTarget.current : null;
						// A gutter press chose the row; an existing column highlight wins for the
						// column, so click-to-select then right-click stays one chain.
						const row = isGutter(cell) && frozen?.row != null ? frozen.row : located.row;
						const column = (columnTarget ?? frozen?.column ?? located.column) as number;
						if (column < 0) return;
						// A second right-click on the very target the menu is about is a dismiss, not
						// a re-target: it is the gesture users expect to close what the first click
						// opened (and the only one available, since a press on a cell of the target
						// table deliberately keeps the menu alive instead of tearing it down).
						if (tableMenu && tableMenu.table === located.table && tableMenu.row === row && tableMenu.column === column) {
							pressedTarget.current = null;
							closeTableMenu();
							return;
						}
						// The menu moves the caret onto the cell it is about to act on. The action
						// then resolves from that cell, so "当前行 / 当前列" are always what the
						// menu showed rather than a target that changed while it was open.
						pressedTarget.current = null;
						const selected = pressedSelection.current?.table === located.table ? pressedSelection.current : selectedTableRange(located);
						pressedSelection.current = null;
						placeCaretIn(cell);
						// Only the cell is painted: the menu acts on that cell's row and column and the
						// caret is already in it, so a full row band plus column band was more colour
						// than the gesture needs.
						paintTableTarget(located.table, row, column, cell);
						setInsertCount({ row: "1", column: "1" });
						setNumberStart("1");
						if (selected) for (const r of selected.selectedRows ?? []) for (const c of selected.selectedColumns ?? []) cellAt<HTMLTableCellElement>(located.table.rows[r], c)?.setAttribute(CELL_TARGET_ATTRIBUTE, "");
						setTableMenu({ ...selected, x: event.clientX, y: event.clientY, table: located.table, row, column });
					}}
					aria-expanded={!!menu} aria-autocomplete="list" aria-activedescendant={menu && matches.length ? `fp-slash-option-${active}` : undefined}
					onBlurCapture={(event) => {
						// Focus moving into the menu's count field is part of the same gesture:
						// closing the slash menu there would also tear down the structure menu.
						const next = event.relatedTarget as HTMLElement | null;
						if (next?.closest(".fp-table-menu")) event.stopPropagation();
					}}
					onBlur={() => { if (!inTableMenu.current) closeMenu(); }}
					onMouseLeave={() => {
						// Moving the pointer into the menu (or into its count field) leaves the
						// editor root: that is still the same gesture, so the menu stays.
						if (!inTableMenu.current) closeTableMenu();
					}}
					onMouseUp={() => {
						// The painter reads the selection the gesture just made, applies once, then
						// disarms unless it was armed in sticky mode (double click).
						const armed = painterRef.current;
						if (!armed || readOnlyRef.current) return;
						paintBlocks(armed.sampled);
						if (!armed.sticky) setPainter(null);
					}}
					onCompositionStart={closeMenu}
					onCompositionEnd={() => { const code = selectedCode(); if (code) paintCode(code); update(); inspectSlash(); }}
					onKeyUp={() => { const cell = selectedCell(); if (cell || window.getSelection()?.isCollapsed) setTableCell(cell); }}
					onKeyDown={(event) => {
						// The structure menu owns the keyboard while it is open: its count fields
						// take digits, and nothing typed there may reach the document behind it.
						const typingInMenu = (event.target as HTMLElement).closest?.(".fp-table-count");
						if (tableMenu && typingInMenu) return;
						const formula = (event.target as Element).closest<HTMLElement>("[data-rich-math]");
						if (formula && ["Enter", " "].includes(event.key)) { event.preventDefault(); openMath(formula); return; }
						if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a" && !event.nativeEvent.isComposing) {
							const code = selectedCode();
							if (code) {
								event.preventDefault();
								const selection = code.ownerDocument.getSelection();
								const range = code.ownerDocument.createRange(); range.selectNodeContents(code);
								const current = selection?.rangeCount ? selection.getRangeAt(0) : null;
								if (current && !current.collapsed && current.compareBoundaryPoints(Range.START_TO_START, range) <= 0 && current.compareBoundaryPoints(Range.END_TO_END, range) >= 0) range.selectNodeContents(root.current!);
								selection?.removeAllRanges(); selection?.addRange(range); return;
							}
							const cell = selectedCell();
							if (cell) {
								event.preventDefault();
								const range = document.createRange(); range.selectNode(cell.closest("table")!);
								const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
								setTableCell(cell); return;
							}
						}

						if (event.key === " " && !event.nativeEvent.isComposing && markdownShortcut()) { event.preventDefault(); return; }
						if (event.key === "Enter" && !readOnly && !event.nativeEvent.isComposing) {
							const selection = window.getSelection();
							const node = selection?.anchorNode;
							const heading = (node instanceof Element ? node : node?.parentElement)?.closest("h1,h2,h3,h4,h5,h6");
							if (!menu && !event.shiftKey && selection?.isCollapsed && heading && root.current?.contains(heading)) {
								const tail = selection.getRangeAt(0).cloneRange();
								tail.setEnd(heading, heading.childNodes.length);
								if (!tail.toString()) {
									event.preventDefault();
									document.execCommand("insertParagraph");
									command("formatBlock", "p"); return;
								}
							}
							const code = selectedCode();
							if (code) { event.preventDefault(); command("insertLineBreak"); return; }
						}
						if (event.key === "Tab" && !readOnly && !event.nativeEvent.isComposing) {
							const cell = selectedCell();
							const node = window.getSelection()?.anchorNode;
							const listItem = (node instanceof Element ? node : node?.parentElement)?.closest("li");
							if (!cell && listItem && root.current?.contains(listItem)) { event.preventDefault(); command(event.shiftKey ? "outdent" : "indent"); return; }
							if (cell) {
								// Tab walks content cells only: the gutter is not a stop, and passing the
								// last cell appends a row (kept from the original behaviour).
								const table = cell.closest("table")!;
								const cells = table ? Array.from(table.querySelectorAll<HTMLTableCellElement>("th, td")).filter(entry => !isGutter(entry)) : [];
								const index = cells.indexOf(cell);
								if (!event.shiftKey || index > 0) {
									event.preventDefault();
									const located = locateCell(cell);
									if (!event.shiftKey && index === cells.length - 1 && located) editTable("rowBelow", located);
									else focusCell(cells[index + (event.shiftKey ? -1 : 1)]);
									return;
								}
							}
						}
						if (!menu || event.nativeEvent.isComposing) return;
						if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); }
						else if (event.key === "ArrowDown" || event.key === "ArrowUp" || (wiki && !menu.query && (event.key === "ArrowLeft" || event.key === "ArrowRight"))) {
							event.preventDefault();
							if (wiki && !menu.query && ["ArrowDown", "ArrowUp"].includes(event.key)) {
								const buttons = [...(popup.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
								const current = buttons[active]?.getBoundingClientRect();
								if (current) {
									const down = event.key === "ArrowDown";
									const rows = buttons.map((button, index) => ({ index, rect: button.getBoundingClientRect() })).filter(({rect}) => down ? rect.top > current.top + 1 : rect.top < current.top - 1);
									rows.sort((a,b) => Math.abs(a.rect.top-current.top)-Math.abs(b.rect.top-current.top) || Math.abs(a.rect.left+a.rect.width/2-current.left-current.width/2)-Math.abs(b.rect.left+b.rect.width/2-current.left-current.width/2));
									setActive(rows[0]?.index ?? (down ? 0 : matches.length - 1));
								}
							} else setActive(index => matches.length ? (index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + matches.length) % matches.length : 0);
						} else if (event.key === "Enter" && matches.length) { event.preventDefault(); insert(active); }
						else if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") closeMenu();
					}}
					onInput={(event) => {
						const input = event.target as HTMLInputElement;
						if (input.type === "checkbox") input.toggleAttribute("checked", input.checked);
						update();
						if (!(event.nativeEvent as InputEvent).isComposing) {
							inspectSlash();
							const selection = window.getSelection(), node = selection?.anchorNode;
							if (wiki && selection?.isCollapsed && node?.nodeType === Node.TEXT_NODE && !node.parentElement?.closest("pre, code, a") && node.textContent?.slice(0, selection.anchorOffset).endsWith("[[")) {
								const range = selection.getRangeAt(0).cloneRange(); range.setStart(node, selection.anchorOffset - 2); linkRange.current = range; setLinkInput("[[");
							}
						}
					}}
					onMouseDown={(event) => {
						pressedTarget.current = null;
						pressedSelection.current = null;
						if (event.button === 2) {
							const cell = (event.target as HTMLElement).closest<HTMLTableCellElement>("th,td");
							const located = cell && locateCell(cell);
							if (located) pressedSelection.current = selectedTableRange(located);
						}
						if (event.button !== 0 || event.shiftKey) return;
						const target = event.target as HTMLElement;
						if (target.closest("button, select, input")) return;
						// Freeze what the structure menu would act on before the press changes it.
						const holder: HTMLTableCellElement | null = target.closest<HTMLTableCellElement>("th, td");
						if (holder && root.current?.contains(holder) && !isGutter(holder)) {
							const located = locateCell(holder);
							if (located) {
								pressedTarget.current = { table: located.table, row: located.row, column: columnTarget ?? located.column };
								pressedSelection.current = null;
							}
						}
						// The row gutter selects its row as a table target; it never takes a caret.
						// A read-only document (streaming, loading, saving) paints no structural
						// targets: the press falls through to the frame gesture, which still
						// selects the whole table — a copy gesture that stays useful read-only.
						const gutter = target.closest<HTMLTableCellElement>(`[${GUTTER_ATTRIBUTE}]`);
						// The header's gutter is a 14px spacer that only aligns the columns: it names no
						// deletable row and no column, so a press there is deliberately a no-op rather
						// than a hidden shortcut. It is styled as chrome (no pointer cursor, no hover
						// tint) so it never looks like the interactive strip below it.
						const headerGutter = !!gutter && isHeaderRow(gutter.parentElement as HTMLTableRowElement | null);
						if (headerGutter && root.current?.contains(gutter)) { event.preventDefault(); return; }
						if (gutter && root.current?.contains(gutter) && !readOnly) {
							event.preventDefault();
							const located = locateCell(gutter);
							if (located) {
								// The row is the target; the caret still has to end up somewhere the
								// following gesture can act on, so it waits in the row's first cell.
								setTableCell(cellAt<HTMLTableCellElement>(located.table.rows[located.row], 0));
								paintTableTarget(located.table, located.row, null);
							}
							return;
						}
						// A header cell is the table's first row of text: a press takes the caret like
						// any other cell, so clicking a column name and typing edits it. Column
						// selection keeps its own affordance — the 6px band along the header's top
						// edge, the same band the table frame uses — plus the structure menu.
						// The gutter is a `th` on header rows, so it must be excluded explicitly.
						const headerCell = target.closest<HTMLTableCellElement>("th");
						const header = headerCell && !isGutter(headerCell) ? headerCell : null;
						if (header && root.current?.contains(header)) {
							const located = locateCell(header);
							// A read-only document paints no column target: the surface must not pretend
							// to offer structural actions it will refuse, so the press falls through to the
							// frame gesture, which still selects the table for copying.
							const band = event.clientY - header.getBoundingClientRect().top <= 6;
							if (located && band && !readOnly) {
								event.preventDefault(); paintTableTarget(located.table, null, located.column);
								return;
							}
						}
						// Any other press in the document drops a structural table selection: it is a
						// one-shot target for the structure menu, not a mode to stay in while editing.
						if (!readOnly && (rowTarget !== null || columnTarget !== null)) clearTableTarget();
						// A header cell can already be detached here (its column highlight replaced it),
						// so fall back to the cell the press started on instead of the press target.
						const block = target.closest<HTMLElement>("pre, table") ?? holder?.closest<HTMLElement>("table") ?? null;
						if (!block || !root.current?.contains(block)) return;
						const rect = block.getBoundingClientRect(), x = event.clientX, y = event.clientY;
						// Code gutters and header padding are part of the selectable frame.
						if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
						const codeRect = block.tagName === "PRE" ? block.querySelector("code")?.getBoundingClientRect() : null;
						const codeFrame = codeRect && (x < codeRect.left || x > codeRect.right || y < codeRect.top || y > codeRect.bottom);
						// The whole-table frame is the outer 6px of the table, plus the row gutter.
						// A header names a column instead, so the two never fight over one press.
						// `holder` is the cell this press started on: a header highlight may already
						// have replaced it, taking the press target out of the document.
						let frame: boolean;
						if (block.tagName === "TABLE") {
							const start = holder?.closest("table") === block ? holder : target.closest<HTMLTableCellElement>("th, td");
							const edge = Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y);
							frame = edge <= 6 || (!!start && isGutter(start));
						} else frame = !!codeFrame || Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y) <= 6;
						if (!frame) return;
						// Keep the native code-block resize grip usable.
						if (block.tagName === "PRE" && rect.right - x < 16 && rect.bottom - y < 16) return;
						event.preventDefault();
						root.current.focus({ preventScroll: true });
						const range = block.ownerDocument.createRange();
						if (block.tagName === "TABLE") { range.selectNode(block); setTableCell(block.querySelector<HTMLTableCellElement>("th, td")); }
						else { const code = block.querySelector("code"); if (!code) return; range.selectNodeContents(code); }
						const selection = block.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
						closeMenu();
					}}
					onDragStart={(event) => {
						if ((event.target as HTMLElement).closest("table a")) event.preventDefault();
					}}
					onClick={(event) => {
						const formula = (event.target as Element).closest<HTMLElement>("[data-rich-math]");
						if (formula) { event.preventDefault(); openMath(formula); return; }
						// Double-clicking a header cell renames it. Every press on a header is a
						// column select, and each of those presses canceled the caret — the native
						// gesture never places one. The caret is put back here with the whole name
						// selected (the context menu's pattern: whoever cancels the native caret
						// places it by hand), so one double-click plus typing replaces the name.
						if (event.detail >= 2) {
							// The gutter is a `th` on header rows: double-clicking the spacer must not
							// start renaming a column that does not exist.
							const headerCell = (event.target as HTMLElement).closest<HTMLTableCellElement>("th");
							const header = headerCell && !isGutter(headerCell) ? headerCell : null;
							if (header && root.current?.contains(header)) {
								clearTableTarget();
								if (!readOnly) {
									root.current.focus({ preventScroll: true });
									caretIn(header);
									const range = document.createRange(); range.selectNodeContents(header);
									const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
									setTableCell(header);
								}
							}
						}
						// A folded diagram is its own reading view: clicking it reveals the
						// source so the block stays editable.
						const preview = (event.target as HTMLElement).closest<HTMLElement>(".wiki-mermaid-preview, .fp-mermaid-preview");
						const folded = preview?.closest<HTMLElement>("pre.wiki-mermaid-source-hidden");
						if (folded) {
							event.preventDefault();
							openMermaidSource.current.add(folded);
							folded.classList.remove("wiki-mermaid-source-hidden");
							const toggle = folded.querySelector<HTMLButtonElement>("button[data-mermaid-source]");
							if (toggle) { toggle.textContent = t("wikiMermaidHideCode"); toggle.setAttribute("aria-expanded", "true"); }
							const code = folded.querySelector("code");
							if (code) {
								root.current?.focus({ preventScroll: true });
								const range = code.ownerDocument.createRange(); range.selectNodeContents(code); range.collapse(false);
								const selection = code.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
							}
							return;
						}
						// The structure-menu press already chose what to act on; the click that
						// follows it must not also re-derive the caret's table cell (an empty
						// cell with no text would hand the next edit to its neighbour).
						if ((event.target as HTMLElement).closest(".fp-table-menu")) return;
						const target = event.target as HTMLElement, toc = target.closest<HTMLElement>("[data-rich-toc]");
						if (toc && target.closest("[data-rich-toc-remove]")) { event.preventDefault(); if (!readOnly) { toc.remove(); update(); } return; }
						const entry = target.closest<HTMLElement>("[data-rich-toc-index]");
						if (toc && entry) { event.preventDefault(); tocTarget(toc, Number(entry.dataset.richTocIndex))?.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
						setTableCell(target.closest<HTMLTableCellElement>("th, td") ?? selectedCell()); closeMenu(); if (!window.getSelection()?.isCollapsed) { event.preventDefault(); return; } const link = (event.target as HTMLElement).closest("a"); if (link) { event.preventDefault(); const href = link.getAttribute("href"); if (href) { if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer"); else wiki?.links?.open(href); } } }}
					onChange={(event) => {
						const input = event.target as HTMLInputElement;
						if (input.type === "checkbox") { input.toggleAttribute("checked", input.checked); update(); }
					}}
					onPaste={(event) => {
						event.preventDefault();
						const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
						if (image) { void pasteImage(image); return; }
						if (readOnly) return;
						const text = event.clipboardData.getData("text/plain");
						// Only text/plain is read: the editor's contract is a small controlled
						// document format, never a general HTML renderer.
						const nodes = classifyPaste(text);
						// Nothing recognized means the paste is ordinary prose: insert it verbatim
						// so the source the user pasted is exactly the source that lands.
						if (!nodes.some(node => node.type !== "text")) { command("insertText", text); return; }
						// One insertHTML call keeps a folded note in a single source fragment.
						command("insertHTML", pasteHtml(nodes));
					}}
					onDrop={(event) => { event.preventDefault(); event.stopPropagation(); }}
				/>
			</div>
		</div>
	</div>;
});
