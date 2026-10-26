import { copyText } from "../clipboard";
import { RichCommands } from "../rich-commands";
import { editableDisclosures } from "../rich-content";
import { RichFormattingToolbar } from "./RichFormattingToolbar";
import { RichLinkCardDialog } from "./RichLinkCardDialog";
import { decorateWikiTables } from "../wiki-table-presentation";
import { WikiTableIcon, WikiQuoteIcon } from "./WikiIcons";
import { WikiToolbar, WikiInsertPopover, type WikiInsertPopup } from "./WikiToolbar";
import { TableSizePicker } from "./TableSizePicker";
import { MermaidDiagram } from "./MermaidDiagram";
import { createPortal } from "react-dom";
import { WikiReadingDialog } from "./WikiReading";
import { TEXT_HIGHLIGHT_COLORS } from "../remark-text-highlight";
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiCalendar, FiBold, FiItalic, FiSquare, FiType, FiCode, FiList, FiCheckSquare, FiMinus, FiLink, FiImage } from "react-icons/fi";
import { markdownImageUrl } from "../markdown-image";
import { withToken } from "../auth-token";
import { getClientId } from "../use-chat";
import { richCodeText } from "../rich-code-text";
import { createRichCodeHighlighter } from "../rich-code-highlight";
import { useT } from "../i18n";
import { LuHeading2, LuHeading3, LuTableOfContents, LuPanelTop, LuInfo, LuLightbulb, LuTriangleAlert, LuChevronsUpDown, LuListOrdered } from "react-icons/lu";
import { mountRichDocument, prepareRichDocument, readRichDocument, renderToc } from "../rich-markdown";
import type { RichDocument, RichLabels } from "../rich-markdown";

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
export const RichMarkdownEditor = memo(function RichMarkdownEditor({ value, readOnly, onChange, file = { cwd: "", path: "" }, wiki, host, compact = false }: {
	file?: { cwd: string; path: string };
	host?: RichEditorHost;
	compact?: boolean;
	wiki?: { paths: string[]; ask: (text: string) => void; followLink: (href: string) => void; resolveCode: (value: string) => string | undefined; added: Set<string>; toolbarHost?: HTMLElement | null; focused?: boolean; onWidth?: () => void };
	value: string;
	readOnly: boolean;
	onChange: (value: string) => void;
}) {
	const t = useT();
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
	useEffect(() => {
		const refresh = () => {
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
		if (wiki) decorateWikiTables(root.current);
		if (wiki) {
			root.current.querySelectorAll<HTMLElement>("pre:has(> code)").forEach(pre => pre.classList.add("codeblock"));
			root.current.querySelectorAll<HTMLElement>("h2").forEach((heading, index) => { heading.id = `wiki-heading-${index}`; });
			root.current.querySelectorAll<HTMLElement>("p").forEach(p => { if ([...wiki.added].some(line => line.trim() && p.textContent?.includes(line))) p.classList.add("wiki-added"); });
			root.current.querySelectorAll<HTMLElement>("code").forEach(code => {
				if (code.closest("pre") || !wiki.resolveCode(code.textContent ?? "")) return;
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
		if (!wiki || !root.current) return;
		root.current.querySelectorAll<HTMLElement>("p").forEach(p => p.classList.toggle("wiki-added", [...wiki.added].some(line => line.trim() && p.textContent?.includes(line))));
	}, [wiki?.added, value]);
	useLayoutEffect(() => {
		root.current?.querySelectorAll<HTMLTableElement>("table").forEach(table => {
			// A table with no data-cell content is an empty template (fresh /table insert
			// or fully cleared): stretch it across the prose width instead of leaving a
			// large blank area to its right. Any content shrinks it back.
			const empty = [...table.querySelectorAll("td")].every(cell => !cell.textContent?.trim() && !cell.querySelector("img, video, audio"));
			table.classList.toggle("rich-table-empty", empty);
		});
	}, [value]);
	useLayoutEffect(() => {
		if (readOnly) closeMenu();
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
				width.title = t(wiki.focused ? "wikiStandardWidth" : "wikiWideWidth"); width.setAttribute("aria-label", width.title); width.onmousedown = event => event.preventDefault(); width.onclick = () => wiki.onWidth?.();
			} else {
				pre.querySelector(".wiki-code-gutter")?.remove(); pre.querySelector("[data-code-fold]")?.remove(); pre.querySelector("[data-code-width]")?.remove(); pre.removeAttribute("data-wiki-code-folded");
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
	}, [value, readOnly, t, wiki?.focused, host?.runCode]);
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
		if (!wiki || !root.current) return;
		const next: { host: HTMLElement; code: string }[] = [];
		const caret = window.getSelection()?.anchorNode ?? null;
		root.current.querySelectorAll<HTMLElement>('pre > code.language-mermaid').forEach(code => {
			const pre = code.parentElement!;
			let host = pre.querySelector<HTMLElement>('.wiki-mermaid-preview');
			if (!host) { host = document.createElement('div'); host.dataset.richUi = ''; host.contentEditable = 'false'; host.className = 'wiki-mermaid-preview'; pre.prepend(host); }
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
		root.current.querySelectorAll<HTMLElement>('.wiki-mermaid-preview').forEach(host => { if (!next.some(item => item.host === host)) host.remove(); });
		root.current.querySelectorAll<HTMLElement>('pre.wiki-mermaid').forEach(pre => {
			if (pre.querySelector('code.language-mermaid')) return;
			pre.classList.remove('wiki-mermaid', 'wiki-mermaid-source-hidden');
			pre.querySelector('button[data-mermaid-source]')?.remove();
		});
		setDiagrams(next);
	}, [value, t]);
	const selectedCell = () => {
		const node = window.getSelection()?.anchorNode;
		const element = node instanceof Element ? node : node?.parentElement;
		const cell = element?.closest<HTMLTableCellElement>("th, td") ?? null;
		return cell && root.current?.contains(cell) ? cell : null;
	};
	const focusCell = (cell: HTMLTableCellElement) => {
		root.current?.focus();
		const range = document.createRange();
		range.selectNodeContents(cell); range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges(); selection?.addRange(range);
		setTableCell(cell);
	};
	const editTable = (action: "row" | "column" | "removeRow" | "removeColumn" | "removeTable" | "selectTable" | "left" | "center" | "right", target = tableCell) => {
		if (readOnly || !target || !root.current?.contains(target)) return;
		const original = target.closest("table")!;
		const table = original.cloneNode(true) as HTMLTableElement;
		const row = table.rows[(target.parentElement as HTMLTableRowElement).rowIndex];
		const column = target.cellIndex;
		let next = row.cells[column];
		if (action === "removeTable" || action === "selectTable") {
			const range = document.createRange();
			range.selectNode(original);
			const selection = window.getSelection();
			root.current.focus(); selection?.removeAllRanges(); selection?.addRange(range);
			if (action === "removeTable") { command("delete"); setTableCell(null); }
			return;
		}
		if (["left", "center", "right"].includes(action)) {
			for (const current of Array.from(table.rows)) current.cells[column].style.textAlign = action;
		} else if (action === "row") {
			const added = document.createElement("tr");
			for (const header of Array.from(table.rows[0].cells)) {
				const cell = added.insertCell();
				cell.style.textAlign = header.style.textAlign;
				cell.append(document.createElement("br"));
			}
			if (row.parentElement?.tagName === "THEAD") (table.tBodies[0] ?? table.createTBody()).prepend(added);
			else row.after(added);
			next = added.cells[0];
		} else if (action === "column") {
			for (const current of Array.from(table.rows)) {
				const cell = document.createElement(current.cells[0].tagName === "TH" ? "th" : "td");
				cell.style.textAlign = current.cells[column].style.textAlign;
				if (cell.tagName === "TH") cell.textContent = t("richColumn");
				else cell.append(document.createElement("br"));
				current.cells[column].after(cell);
				if (current === row) next = cell;
			}
		} else if (action === "removeRow") {
			if (row.rowIndex === 0 || table.rows.length <= 2) return;
			next = table.rows[row.rowIndex - 1].cells[column];
			row.remove();
		} else {
			if (row.cells.length <= 1) return;
			next = row.cells[column > 0 ? column - 1 : 1];
			for (const current of Array.from(table.rows)) current.deleteCell(column);
		}
		const rowIndex = (next.parentElement as HTMLTableRowElement).rowIndex, cellIndex = next.cellIndex;
		table.dataset.richTableChange = "";
		const range = document.createRange(); range.selectNode(original);
		root.current.focus(); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
		command("insertHTML", table.outerHTML);
		const inserted = root.current.querySelector<HTMLTableElement>("[data-rich-table-change]");
		if (inserted) { inserted.removeAttribute("data-rich-table-change"); focusCell(inserted.rows[rowIndex].cells[cellIndex]); }
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
		{ label: "richLinkCard", alias: "card", keywords: "card link 卡片 链接", action: "card" },
		{ label: "wikiAddLink", alias: "link", keywords: "url link 链接", action: "link" },
		{ label: "richTable", alias: "bg", keywords: "table bg biaoge 表格", action: "insertHTML", argument: `<table><thead><tr><th data-slash-insert>${t("richColumn")} 1</th><th>${t("richColumn")} 2</th></tr></thead><tbody><tr><td>…</td><td>…</td></tr></tbody></table><p><br></p>` },
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
	const wikiOrder = ["zw", "bt1", "bt2", "bt3", "bt4", "bt5", "bt6", "lb", "bh", "rw", "link", "dmk", "tp", "bg", "yy", "fgx", "date", "sl", "ml", "glk", "tip", "warning", "collapse", "card"];
	const items = wiki ? allItems.filter(item => wikiOrder.includes(item.alias)).sort((a, b) => wikiOrder.indexOf(a.alias) - wikiOrder.indexOf(b.alias)) : allItems.filter(item => !["date", "sl", "ml"].includes(item.alias));
	const icons = { richGreenBlock: wiki ? <LuLightbulb /> : <FiSquare />, richYellowBlock: wiki ? <LuTriangleAlert /> : <FiSquare />, richCollapse: wiki ? <LuChevronsUpDown /> : <FiSquare />, richLinkCard: wiki ? <LuPanelTop /> : <FiLink />, wikiAddLink: <FiLink />, wikiMentionDate: <FiCalendar />, richImage: <FiImage />, richWikiLink: <FiLink />, richHighlightBlock: wiki ? <LuInfo /> : <FiSquare />, richHeading: <FiType />, richParagraph: <FiType />, richCodeBlock: <FiCode />, richTable: <WikiTableIcon />, richList: <FiList />, richOrderedList: wiki ? <LuListOrdered /> : <FiList />, richTaskList: <FiCheckSquare />, richQuote: <WikiQuoteIcon />, richDivider: <FiMinus />, richTocInsert: <LuTableOfContents /> };
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
		if (id === "card") { cardRange.current = window.getSelection()?.getRangeAt(0).cloneRange() ?? null; setCardOpen(true); return; }
		if (id === "link") { linkRange.current = window.getSelection()?.getRangeAt(0).cloneRange() ?? null; setLinkInput(""); return; }
		if (id === "bg" && dimensions) {
			command("insertHTML", `<table><thead><tr>${Array.from({ length: dimensions.columns }, (_, i) => `<th ${i === 0 ? 'data-slash-insert' : ''}>${t("richColumn")} ${i + 1}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: dimensions.rows - 1 }, () => `<tr>${'<td><br></td>'.repeat(dimensions.columns)}</tr>`).join('')}</tbody></table><p><br></p>`);
		} else if (id === "dmk") command("insertHTML", `<pre><code data-slash-insert class="language-${language || 'plaintext'}">${language === 'mermaid' ? 'flowchart LR\n  A --> B' : '<br>'}</code></pre><p><br></p>`);
		else {
			const item = items.find(item => item.alias === id); if (!item) return;
			if (item.action === "card" || item.action === "link") return;
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
	const format = (action: string, argument?: string) => {
		const selection = window.getSelection(); const node = selection?.anchorNode;
		const element = node instanceof HTMLElement ? node : node?.parentElement;
		if (action === "text-align" && selectedCell() && ["left", "center", "right"].includes(argument ?? "")) { editTable(argument as "left" | "center" | "right", selectedCell()); return; }
		if (action === "task") { insertToolbar("rw"); return; }
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
		if (item.action === "card" || item.action === "link") { prepareInsert(); insertToolbar(item.alias); update(); return; }
		if (item.action === "image") { imageRange.current = selection?.getRangeAt(0).cloneRange() ?? null; imageInput.current?.click(); update(); return; }
		if (item.action === "wikiLink") { linkRange.current = selection?.getRangeAt(0).cloneRange() ?? null; setLinkInput("[["); update(); return; }
		if (item.action === "toc") { insertToc(); return; }
		if (wiki && item.alias === "bg") command("insertHTML", `<table><thead><tr>${[1, 2, 3].map(n => `<th ${n === 1 ? "data-slash-insert" : ""}>${t("richColumn")} ${n}</th>`).join("")}</tr></thead><tbody>${[1, 2].map(() => "<tr><td>…</td><td>…</td><td>…</td></tr>").join("")}</tbody></table><p><br></p>`);
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
		{wiki?.toolbarHost && createPortal(<WikiToolbar readOnly={readOnly} focused={!!wiki.focused} onWidth={wiki.onWidth ?? (() => {})} items={items.map(item => ({ id: item.alias, label: itemLabel(item), hint: hints[item.alias] ?? "", help: t(help[item.alias] ?? item.label), icon: icons[item.label] }))} editor={root.current} commands={commands} />, wiki.toolbarHost)}
		{diagrams.map(({ host, code }, index) => createPortal(<MermaidDiagram code={code} />, host, String(index)))}
		{insertPopup && !readOnly && <WikiInsertPopover popup={insertPopup} onClose={() => { setInsertPopup(null); restoreInsert(); }}>
			<TableSizePicker onInsert={(columns, rows) => insertToolbar("bg", { columns, rows })} />
		</WikiInsertPopover>}
		{!wiki && !readOnly && <RichFormattingToolbar compact={compact} commands={commands} />}
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
		{wiki && floating && linkInput === null && createPortal(<div ref={floatingToolbar} className="wiki-format-popover" role="toolbar" aria-label={t("richFormatToolbar")} style={{ left: floating.x, top: floating.y }} onMouseDown={e => e.preventDefault()}>
			<button className="wiki-ask-selection" onClick={() => { wiki.ask(window.getSelection()?.toString() ?? ""); setFloating(null); }}>{t("wikiAskPi")}</button>
		</div>, document.querySelector(".wiki-document-dialog") ?? document.body)}
		<input ref={imageInput} type="file" accept="image/*" hidden onChange={event => { const image = event.target.files?.[0], range = imageRange.current; if (image && range && root.current?.contains(range.startContainer)) { root.current.focus(); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); void pasteImage(image); } event.target.value = ""; }} />
		{linkInput !== null && <WikiReadingDialog title={t("wikiAddLink")} onClose={() => setLinkInput(null)}><form className="wiki-link-form" onSubmit={event => { event.preventDefault(); insertLink(linkInput); }}><input aria-label={t("wikiLinkAddress")} placeholder={t("wikiLinkAddress")} value={linkInput} onChange={e => setLinkInput(e.target.value)} /><button type="submit" disabled={!linkInput.trim() || linkInput.startsWith("[[")}>{t("wikiInsertLinkAction")}</button></form>{linkInput.startsWith("[[") && <div className="wiki-link-results">{wiki?.paths.filter(path => /\.(md|markdown|mdown)$/i.test(path) && path.toLowerCase().includes(linkInput.slice(2).toLowerCase())).slice(0, 30).map(path => <button key={path} onClick={() => insertLink(path, true)}>{path}</button>)}</div>}</WikiReadingDialog>}
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
					contentEditable={!readOnly} suppressContentEditableWarning spellCheck={false}
					aria-expanded={!!menu} aria-autocomplete="list" aria-activedescendant={menu && matches.length ? `fp-slash-option-${active}` : undefined}
					onBlur={closeMenu}
					onCompositionStart={closeMenu}
					onCompositionEnd={() => { const code = selectedCode(); if (code) paintCode(code); update(); inspectSlash(); }}
					onKeyUp={() => { const cell = selectedCell(); if (cell || window.getSelection()?.isCollapsed) setTableCell(cell); }}
					onKeyDown={(event) => {
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
								const cells = Array.from(cell.closest("table")!.querySelectorAll<HTMLTableCellElement>("th, td"));
								const index = cells.indexOf(cell);
								if (!event.shiftKey || index > 0) {
									event.preventDefault();
									if (!event.shiftKey && index === cells.length - 1) editTable("row", cell);
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
						if (event.button !== 0 || event.shiftKey) return;
						const target = event.target as HTMLElement;
						if (target.closest("button, select, input")) return;
						const block = target.closest<HTMLElement>("pre, table");
						if (!block || !root.current?.contains(block)) return;
						const rect = block.getBoundingClientRect(), x = event.clientX, y = event.clientY;
						// Code gutters and header padding are part of the selectable frame.
						if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
						const codeRect = block.tagName === "PRE" ? block.querySelector("code")?.getBoundingClientRect() : null;
						const codeFrame = codeRect && (x < codeRect.left || x > codeRect.right || y < codeRect.top || y > codeRect.bottom);
						if (!codeFrame && Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y) > 6) return;
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
						const target = event.target as HTMLElement, toc = target.closest<HTMLElement>("[data-rich-toc]");
						if (toc && target.closest("[data-rich-toc-remove]")) { event.preventDefault(); if (!readOnly) { toc.remove(); update(); } return; }
						const entry = target.closest<HTMLElement>("[data-rich-toc-index]");
						if (toc && entry) { event.preventDefault(); tocTarget(toc, Number(entry.dataset.richTocIndex))?.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
						setTableCell(target.closest<HTMLTableCellElement>("th, td") ?? selectedCell()); closeMenu(); if (!window.getSelection()?.isCollapsed) { event.preventDefault(); return; } const link = (event.target as HTMLElement).closest("a"); if (link) { event.preventDefault(); const href = link.getAttribute("href"); if (href) { if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer"); else wiki?.followLink(href); } } }}
					onChange={(event) => {
						const input = event.target as HTMLInputElement;
						if (input.type === "checkbox") { input.toggleAttribute("checked", input.checked); update(); }
					}}
					onPaste={(event) => {
						event.preventDefault();
						const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
						if (image) { void pasteImage(image); return; }
						if (!readOnly) command("insertText", event.clipboardData.getData("text/plain"));
					}}
					onDrop={(event) => { event.preventDefault(); event.stopPropagation(); }}
				/>
			</div>
		</div>
	</div>;
});
