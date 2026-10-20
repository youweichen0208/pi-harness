import { WikiReadingOutline } from "../wiki-reading-outline";
import { LuCode, LuMoveHorizontal } from "react-icons/lu";
import { useDialogFocus } from "../use-dialog-focus";
import { wikiProperties } from "../wiki-properties";
import ReactMarkdown from "react-markdown";
import { useContext, useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { FiPlus, FiCalendar, FiBookOpen, FiChevronDown, FiChevronRight, FiFile, FiFolder, FiRefreshCw, FiSearch, FiX, FiClock, FiCornerUpLeft, FiCornerUpRight, FiLink } from "react-icons/fi";
import { useI18n, useT } from "../i18n";
import type { WikiState, WikiDirectory, WikiDocument, WikiDocumentContent, WikiDocumentReferences, WikiRevision, WikiChange, WikiSearchResult } from "../types";
import { wikiRequest, wikiMedia } from "../wiki-api";
import { wikiMetadata, resolveWikiLink, explicitWikiFilePath } from "../wiki-document";
import { WikiResizeHandle, useWikiPanelWidth } from "./WikiResizeHandle";
import { CreateFileForm } from "./CreateFileForm";
import type { CurrentFileContext, ReadCurrentFile, SaveCurrentFile } from "../current-file";
import type { ChatReferenceRequest } from "../chat-reference";
import { RichMarkdownEditor } from "./RichMarkdownEditor";
import { CodeFileEditor } from "./CodeFileEditor";
import { desktopAPI, registerWindowSave } from "../desktop";
import { getClientId } from "../use-chat";
import { WikiIndexIndicator } from "./WikiReading";
import { WikiImageZoom } from "./WikiImageZoom";
import { useWikiAutosave } from "../use-wiki-autosave";
import { randomUuid } from "../uuid";

type Guard = (next: () => void) => void;
const EMPTY: WikiState = { entries: [], tags: [], revisions: [], running: false, limited: false };
const NO_ADDED_LINES = new Set<string>();
const readingPositions = new Map<string, number>();
export function WikiWorkbench({ cwd, conversationId, streaming, active, ready, guard, fileRequest, openDocument, onOpenFolder, folderBusy, connected, writingBlocked, onReference, saveBeforePrompt, onAttach, contextReader, contextSaver, onContextChange }: {
	cwd: string; conversationId: string; streaming: boolean; active: boolean; ready: boolean;
	fileRequest: {path:string;token:string}; writingBlocked: boolean; connected: boolean;
	openDocument: (path: string) => Promise<void>;
	onOpenFolder: () => void;
	folderBusy: boolean;
	onAttach: (path: string, name: string, isDir: boolean) => void;
	onReference: (request: ChatReferenceRequest) => void;
	guard: MutableRefObject<Guard | null>;
	saveBeforePrompt: MutableRefObject<(() => Promise<boolean>) | null>;
	contextReader: MutableRefObject<ReadCurrentFile | null>;
	contextSaver: MutableRefObject<SaveCurrentFile | null>;
	onContextChange: (context: CurrentFileContext | null) => void;
}) {
	const t = useT(), { locale } = useI18n();
	const [state, setState] = useState<WikiState>(EMPTY);
	const [directories, setDirectories] = useState<Record<string, WikiDirectory>>({});
	const [fullChanges, setFullChanges] = useState<Record<string, WikiChange>>({});
	const [path, setPath] = useState(fileRequest.path);
	const [referencesReady, setReferencesReady] = useState(false);
	const [backlinkLimit, setBacklinkLimit] = useState(100);
	const [doc, setDoc] = useState<WikiDocument | null>(null), [draft, setDraft] = useState("");
	const [source, setSource] = useState(false), [loading, setLoading] = useState(false), [restoring, setRestoring] = useState(false);
	const [error, setError] = useState(""), [nav, setNav] = useState<(() => void) | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [showHidden, setShowHidden] = useState(() => localStorage.getItem(`pi-wiki-hidden:${cwd}`) === "true");
	const [sidebarWidth, resizeSidebar] = useWikiPanelWidth("sidebar");
	const [focused, setFocused] = useState(false);
	const [editorToolbarHost, setEditorToolbarHost] = useState<HTMLDivElement | null>(null);
	const readingOutline = useContext(WikiReadingOutline);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [creating, setCreating] = useState(false);
	useEffect(() => setCreating(false), [active, conversationId]);
	const initialDocumentRequest = useRef<string | null>(null);
	const [drawer, setDrawer] = useState<"recent" | string | null>(null);
	const [search, setSearch] = useState(false), [query, setQuery] = useState(""), [results, setResults] = useState<WikiSearchResult[]>([]);
	const searchDialogRef = useDialogFocus<HTMLElement>(active && search);
	const navigationDialogRef = useDialogFocus<HTMLElement>(active && !!nav);
	const [searching, setSearching] = useState(false), [searchLimited, setSearchLimited] = useState(false), [cursor, setCursor] = useState(0);
	const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(null);
	const [zoomImage, setZoomImage] = useState<{ src: string; alt: string } | null>(null);
	const [sending, setSending] = useState(false);
	const [viewed, setViewed] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem(`pi-wiki-viewed:${cwd}`) ?? "{}"); } catch { return {}; } });
	const [now, setNow] = useState(Date.now());
	const [host, setHost] = useState<HTMLElement | null>(null);
	const [statusHost, setStatusHost] = useState<HTMLElement | null>(null);
	const article = useRef<HTMLElement>(null);
	const alive = useRef(true), docSequence = useRef(0), stateSequence = useRef(0), referenceSequence = useRef(0);
	const checkedEntries = useRef(state.entries);
	const revisionRef = useRef(state.revisions), loadedPiRevision = useRef<string | undefined>(undefined);
	revisionRef.current = state.revisions;
	const docRef = useRef(doc), dirty = !!doc?.editable && doc.text !== undefined && draft !== doc.text;
	docRef.current = doc;
	const editorBusy = sending || restoring || loading || state.running || writingBlocked || (!!doc && doc.entry.path !== path);
	const busy = editorBusy || !ready;
	const changedPaths = new Set(state.revisions.filter(r => r.author === "pi").flatMap(r => r.changes.filter(c => !c.undone && (viewed[c.path] ?? 0) < r.at).map(c => c.path)));
	const entries = useMemo(() => {
		const merged = new Map(state.entries.map(e => [e.path, e]));
		for (const directory of Object.values(directories)) {
			const unindexed = !state.entries.length || state.limited || state.entries.some(e => e.symlink && directory.path.startsWith(e.path));
			for (const entry of directory.entries) if (!merged.has(entry.path) && unindexed) merged.set(entry.path, entry);
		}
		// Sort by path segments with folders before files at each level.
		return [...merged.values()].sort((a, b) => {
			const aa = a.path.split("/"), bb = b.path.split("/");
			for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
				if (aa[i] === bb[i]) continue;
				const ad = i < aa.length - 1 || a.kind === "directory", bd = i < bb.length - 1 || b.kind === "directory";
				return Number(bd) - Number(ad) || aa[i].localeCompare(bb[i]);
			}
			return aa.length - bb.length;
		});
	}, [state.entries, state.limited, directories]);
	const paths = useMemo(() => entries.filter(e => e.kind !== "directory").map(e => e.path), [entries]);
	const hiddenRoots = useMemo(() => new Set(entries.filter(e => e.kind === "directory" && !e.path.includes("/") && e.name.startsWith(".")).map(e => e.path)), [entries]);
	const visibleEntries = useMemo(() => entries.filter(e => (showHidden || !hiddenRoots.has(e.path.split("/")[0])) && e.path.split("/").slice(0, -1).every((_, i, parts) => expanded.has(parts.slice(0, i + 1).join("/")))), [entries, expanded, showHidden, hiddenRoots]);
	const [treeScroll, setTreeScroll] = useState(0);
	const rowStart = Math.max(0, Math.floor(treeScroll / 32) - 10), rowEnd = rowStart + 70;

	useEffect(() => { alive.current = true; return () => { alive.current = false; docSequence.current++; stateSequence.current++; }; }, []);
	useEffect(() => { setHost(document.getElementById("wiki-modal-toolbar")); setStatusHost(document.getElementById("wiki-window-index")); }, [active]);
	const loadDirectory = useCallback(async (target: string, offset = 0) => {
		try {
			const result = await wikiRequest<WikiDirectory>(cwd, "directory", { path: target, offset });
			if (alive.current) setDirectories(prev => ({ ...prev, [target]: { ...result, entries: offset ? [...(prev[target]?.entries ?? []), ...result.entries] : result.entries } }));
		} catch (e) { if (alive.current) setError((e as Error).message); }
	}, [cwd]);
	useEffect(() => {
		setFocused(false); setDrawer(null); setPath(fileRequest.path); setSource(false); setSearch(false); setSelectionMenu(null); setZoomImage(null);
	}, [fileRequest]);
	useEffect(() => { if (active) void loadDirectory(""); }, [active, loadDirectory]);
	const refresh = useCallback(async (fresh = false) => {
		const seq = ++stateSequence.current;
		try { const result = await wikiRequest<WikiState>(cwd, fresh ? "refresh" : "state"); if (alive.current && seq === stateSequence.current) setState(result); }
		catch (e) { if (alive.current && seq === stateSequence.current) setError((e as Error).message); }
	}, [cwd]);
	const autosave = useWikiAutosave(cwd, doc, draft, loading || restoring || state.running || writingBlocked || doc?.entry.path !== path, document => { docRef.current = document; setDoc(document); }, () => void refresh(true));
	const { save, saving } = autosave;
	useLayoutEffect(() => { saveBeforePrompt.current = save; return () => { saveBeforePrompt.current = null; }; }, [save, saveBeforePrompt]);
	useEffect(() => registerWindowSave(save), [save]);
	// Keep Wiki context separate from the background file preview; the composer selects the visible editor.
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const contextEligible = active && !loading && !restoring && doc?.entry.path === fileRequest.path && doc?.entry.path === path && doc?.text !== undefined;
	useLayoutEffect(() => {
		onContextChange(contextEligible && doc ? { id: fileRequest.token, cwd, path: doc.entry.path, name: doc.entry.name, dirty } : null);
	}, [contextEligible, doc?.entry.path, doc?.entry.name, fileRequest.token, cwd, dirty, onContextChange]);
	useLayoutEffect(() => () => onContextChange(null), [onContextChange]);
	useLayoutEffect(() => {
		contextReader.current = id => contextEligible && id === fileRequest.token && docRef.current ? {
			path: fileRequest.path, mode: "inline",
			editorSnapshot: { cwd, text: draftRef.current, dirty: draftRef.current !== docRef.current.text, version: docRef.current.version },
		} : null;
		// Join an in-flight autosave; beforeSend rechecks the modal token before delivery.
		contextSaver.current = (id, next) => {
			if (!contextEligible || id !== fileRequest.token) return false;
			void save().then(ok => { if (ok && alive.current) next(); });
			return true;
		};
		return () => { contextReader.current = null; contextSaver.current = null; };
	}, [contextEligible, fileRequest.token, fileRequest.path, cwd, contextReader, contextSaver, save]);

	useEffect(() => {
		if (!active) return;
		void refresh();
		const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, streaming || state.running ? 1000 : 30000);
		return () => clearInterval(timer);
	}, [active, streaming, state.running, refresh]);
	useEffect(() => { if (!path) return; setExpanded(prev => { const next = new Set(prev), parts = path.split("/"); for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/")); return next; }); }, [path]);
	useEffect(() => {
		if (path || !state.entries.length || initialDocumentRequest.current === fileRequest.token) return;
		const initial = state.entries.find(e => /^(readme|index)\.md$/i.test(e.path)) ?? state.entries.find(e => e.kind === "document");
		if (initial) {
			initialDocumentRequest.current = fileRequest.token;
			void openDocument(initial.path); // Keep the URL, temporary chat and file chip on the same document.
		}
	}, [state.entries, path, fileRequest.token, openDocument]);
	const loadReferences = useCallback(async (target: string, documentSequence: number) => {
		const sequence = ++referenceSequence.current;
		try {
			const references = await wikiRequest<WikiDocumentReferences>(cwd, "document-references", { path: target });
			if (!alive.current || documentSequence !== docSequence.current || sequence !== referenceSequence.current) return;
			setDoc(current => current?.entry.path === target ? { ...current, ...references } : current);
			setReferencesReady(true);
		} catch (e) { if (alive.current && documentSequence === docSequence.current && sequence === referenceSequence.current) setError((e as Error).message); }
	}, [cwd]);
	const load = useCallback(async (target: string, markViewed = false) => {
		const seq = ++docSequence.current;
		setLoading(true); setReferencesReady(false); setBacklinkLimit(100); setError("");
		try {
			const content = wikiRequest<WikiDocumentContent>(cwd, "document-content", { path: target });
			const result = await content;
			if (!alive.current || seq !== docSequence.current) return;
			loadedPiRevision.current = revisionRef.current.find(r => r.author === "pi" && r.changes.some(c => c.path === target))?.id;
			setDoc({ ...result, backlinks: [] }); setDraft(result.text ?? ""); setSelectionMenu(null);
			void loadReferences(target, seq);
			localStorage.setItem(`pi-wiki-file:${cwd}`, target);
			if (markViewed) setViewed(v => { const next = { ...v, [target]: Date.now() }; localStorage.setItem(`pi-wiki-viewed:${cwd}`, JSON.stringify(next)); return next; });
		} catch (e) { if (alive.current && seq === docSequence.current) { setDoc(null); setError((e as Error).message); } }
		finally { if (alive.current && seq === docSequence.current) setLoading(false); }
	}, [cwd, loadReferences]);
	useEffect(() => { if (path && active && docRef.current?.entry.path !== path) void load(path, true); return () => { docSequence.current++; }; }, [path, active, load]);
	useEffect(() => {
		if (active && docRef.current?.entry.path === path && state.entries.length) void loadReferences(path, docSequence.current);
	}, [state.entries, active, path, loadReferences]);
	useEffect(() => {
		if (!doc || dirty || saving || loading || streaming || state.running || !active || checkedEntries.current === state.entries) return;
		checkedEntries.current = state.entries;
		const entry = state.entries.find(e => e.path === path);
		const piRevision = state.revisions.find(r => r.author === "pi" && r.changes.some(c => c.path === path));
		if (!entry || entry.modified === doc.entry.modified) { loadedPiRevision.current = piRevision?.id; return; }
		if (!doc.editable || piRevision?.id !== loadedPiRevision.current) { void load(path); return; }
		const before = doc, sequence = docSequence.current;
		void wikiRequest<WikiDocumentContent>(cwd, "document-content", { path }).then(latest => {
			if (!alive.current || sequence !== docSequence.current || docRef.current?.version !== before.version) return;
			if (latest.version !== before.version) autosave.noteExternalChange();
			else setDoc(current => current ? { ...current, entry: latest.entry } : current);
		}).catch(e => { if (alive.current && sequence === docSequence.current) setError(e.message); });
	}, [state.entries, doc, dirty, saving, loading, active, path, load, cwd, state.revisions, state.running, streaming, autosave.noteExternalChange]);
	useEffect(() => {
		if (!nav) return;
		const previous = document.activeElement;
		document.querySelector<HTMLElement>(".wiki-confirm button")?.focus();
		return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
	}, [nav]);
	const navigationSequence = useRef(0);
	const navigate = useCallback<Guard>((next) => { const sequence = ++navigationSequence.current; if (dirty || saving) { void save().then(ok => { if (!alive.current || sequence !== navigationSequence.current) return; if (ok) next(); else setNav(() => next); }); } else next(); }, [dirty, saving, save]);
	useEffect(() => { guard.current = dirty || saving ? navigate : null; return () => { guard.current = null; }; }, [guard, navigate, dirty, saving]);
	useEffect(() => { const leave = (e: BeforeUnloadEvent) => { if (dirty) { void save(); e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave); }, [dirty, save]);
	const open = (target: string) => navigate(() => {
		if (target !== path) { void openDocument(target); return; }
		setPath(target); setSource(false); setSearch(false); setSelectionMenu(null);
		setExpanded(prev => { const next = new Set(prev), parts = target.split("/"); for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/")); return next; });
		if (target === path) void load(target, true);
	});

	useEffect(() => {
		if (!active) return;
		const key = (e: KeyboardEvent) => {

			if (e.defaultPrevented) return;

			if ((e.metaKey || e.ctrlKey) && ["k", "p"].includes(e.key.toLowerCase())) { e.preventDefault(); setSearch(s => !s); }
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!editorBusy) void save(); }
			if (e.key === "Escape" && (nav || search || selectionMenu || drawer)) {
				e.preventDefault();
				if (nav) setNav(null); else if (search) setSearch(false); else if (selectionMenu) setSelectionMenu(null); else if (drawer) setDrawer(null);
			}
		};
		window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
	});
	useEffect(() => {
		if (!search || !query.trim()) { setResults([]); setSearching(false); return; }
		const controller = new AbortController(); setSearching(true); setResults([]); setSearchLimited(false); setCursor(0);
		const timer = setTimeout(() => {
			void wikiRequest<{ results: WikiSearchResult[]; limited: boolean }>(cwd, "search", { query }, controller.signal).then(result => { if (!controller.signal.aborted) { setResults(result.results.sort((a, b) => ["document", "code", "pdf", "image", "other"].indexOf(a.kind) - ["document", "code", "pdf", "image", "other"].indexOf(b.kind))); setSearchLimited(result.limited); } }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setSearching(false); });
		}, 250);
		return () => { clearTimeout(timer); controller.abort(); };
	}, [cwd, query, search]);
	useEffect(() => { if (search) document.querySelector(".wiki-search-results button.selected")?.scrollIntoView({ block: "nearest" }); }, [search, cursor]);
	const restore = async (revision: WikiRevision, undo: boolean, file?: string) => {
		if (dirty) { setError(t("wikiSaveFirst")); return; }
		setRestoring(true); setError("");
		try { const result = await wikiRequest<WikiState>(cwd, "restore", { id: revision.id, undo, path: file }); if (alive.current) { setState(result); if (path) await load(path); } }
		catch (e) { if (alive.current) setError((e as Error).message); }
		finally { if (alive.current) setRestoring(false); }
	};
	const ask = async (text: string, target = path) => {
		if (sending || !text.trim()) return;
		const sequence = docSequence.current;
		const request = { id: randomUuid(), cwd, conversationId, path: target, text };
		setSending(true);
		try {
			if (!await save()) return;
			if (alive.current && sequence === docSequence.current) onReference(request);
		} finally { if (alive.current) setSending(false); }
	};
	const attachResult = (result: WikiSearchResult) => { void ask(result.snippet, result.path); };
	const selectText = () => {
		const selected = window.getSelection();
		if (!selected || selected.isCollapsed || !article.current?.contains(selected.anchorNode) || !article.current?.contains(selected.focusNode)) { setSelectionMenu(null); return; }
		const text = selected.toString(), rect = selected.getRangeAt(0).getBoundingClientRect();
		if (text.trim()) setSelectionMenu({ text, x: Math.max(8, Math.min(rect.left, window.innerWidth - 300)), y: Math.min(rect.bottom + 8, window.innerHeight - 50) });
	};
	const peekImage = (event: React.MouseEvent) => {
		const img = (event.target as HTMLElement).closest?.("img");
		if (img instanceof HTMLImageElement && article.current?.contains(img)) setZoomImage({ src: img.currentSrc || img.src, alt: img.alt });
	};
	const followLink = (href: string) => {
		let reference = href;
		try { if (href.startsWith("#wiki=")) reference = decodeURIComponent(href.slice(6)); } catch { return; }
		const target = resolveWikiLink(path, reference, paths) ?? explicitWikiFilePath(path, reference);
		if (target) open(target); else setError(t("wikiMissingLink", { path: reference }));
	};
	const properties = useMemo(() => wikiProperties(draft).rows, [draft]);
	const metadata = useMemo(() => wikiMetadata(draft), [draft]);
	const modified = new Date(doc?.entry.modified ?? 0), today = new Date(now);
	const updatedLabel = modified.toDateString() === today.toDateString()
		? t("wikiUpdatedToday", { time: modified.toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) })
		: t("wikiUpdatedDate", { date: modified.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { month: "long", day: "numeric", ...(modified.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) }) });
	const backlinkCount = new Set(doc?.backlinks.map(link => link.path)).size;

	const errorBanner = error && <div className="wiki-error" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label={t("close")}><FiX /></button>{doc && <button onClick={() => navigate(() => void load(path))}>{t("wikiReload")}</button>}</div>;
	useLayoutEffect(() => {
		const key = `${cwd}:${path}`, element = scrollRef.current;
		if (!element || loading || doc?.entry.path !== path) return;
		element.scrollTop = readingPositions.get(key) ?? 0;
		const remember = () => {
			readingPositions.delete(key); readingPositions.set(key, element.scrollTop);
			if (readingPositions.size > 100) readingPositions.delete(readingPositions.keys().next().value!);
		};
		element.addEventListener("scroll", remember);
		return () => { element.removeEventListener("scroll", remember); };
	}, [cwd, path, loading, doc?.entry.path]);
	const saveStatus = doc?.editable && <button className={`wiki-save-status ${autosave.failure ? "failed" : saving || dirty ? "saving" : "saved"}`} onClick={() => void save()} title={autosave.failure || undefined} disabled={!autosave.failure || autosave.conflict} aria-live="polite"><i />{t(autosave.failure ? "wikiSaveFailedRetry" : saving || dirty ? "wikiSaving" : "wikiSaved")}</button>;
	const sourceButton = <button className="wiki-source-toggle" disabled={!doc?.editable || loading || doc.entry.path !== path} aria-pressed={source} onClick={() => setSource(s => !s)}><LuCode />{t(source ? "wikiPreview" : "wikiSource")}</button>;
	const toolbar = <>
		<div className="wiki-breadcrumb" title={`${cwd}/${path}`}><span className="wiki-path-parent">{path.includes("/") && <><span className="wiki-path-segment">{path.split("/").slice(0, -2).map(part => `${part} / `).join("")}</span><span className="wiki-path-tail">{path.split("/").at(-2)} / </span></>}</span><b>{path.split("/").at(-1) || t("wikiMode")}</b>{saveStatus}</div>
		<div className="wiki-toolbar-actions">
			<button aria-label={t("wikiSearchAll")} title={t("wikiSearchAll")} onClick={() => setSearch(true)}><FiSearch /><span>{t("wikiSearchAll")}</span></button>
			<button aria-label={t("wikiRecent")} title={t("wikiRecent")} onClick={() => { setFocused(false); setDrawer(drawer === "recent" ? null : "recent"); }} className={drawer === "recent" ? "active" : ""}><FiClock /><span>{t("wikiRecent")}</span></button>
		</div>
	</>;
	return <section className={`wiki-workbench ${focused ? "is-focused" : ""} ${drawer ? "with-drawer" : ""} `} aria-label={t("wikiMode")} style={{ "--wiki-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
		{active && host && createPortal(toolbar, host)}

		<aside className="wiki-sidebar open">
			<WikiResizeHandle side="sidebar" width={sidebarWidth} onResize={resizeSidebar} />
			<button className="file-search-trigger" aria-label={t("wikiOpenFolder")} title={`${t("wikiOpenFolder")} · ${cwd}`} disabled={folderBusy} onClick={onOpenFolder}><FiFolder /><span>{t("wikiOpenFolder")}</span></button>
			<button className="wiki-search-trigger file-search-trigger" onClick={() => setSearch(true)}><FiSearch /><span>{t("fileTreeSearch")}</span><kbd>{navigator.platform.includes("Mac") ? "⌘ P" : "Ctrl P"}</kbd></button>
			<div className="wiki-tree-label"><span>{t("wikiFiles")}</span><button aria-label={t("newWorkspaceFile")} title={t("newWorkspaceFile")} disabled={writingBlocked || !connected || state.running} onClick={() => setCreating(value => !value)}><FiPlus /></button><button aria-label={t("wikiRefresh")} onClick={() => void refresh(true)}><FiRefreshCw /></button></div>
			{creating && <CreateFileForm key={`${cwd}:${conversationId}`} cwd={cwd} conversationId={conversationId} initialPath={path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : ""} disabled={writingBlocked || !connected || state.running} onCancel={() => setCreating(false)} onCreated={target => { setCreating(false); void refresh(true); open(target); }} />}
			<div className="wiki-tree" role="tree" aria-label={t("wikiFiles")} onScroll={e => setTreeScroll(e.currentTarget.scrollTop)}>
				{hiddenRoots.size > 0 && <button className="wiki-tree-row wiki-hidden-folders" role="treeitem" aria-expanded={showHidden} onClick={() => { const value = !showHidden; setShowHidden(value); localStorage.setItem(`pi-wiki-hidden:${cwd}`, String(value)); setTreeScroll(0); }}>
					{showHidden ? <FiChevronDown /> : <FiChevronRight />}<span>{t("wikiHiddenFolders", { count: hiddenRoots.size })}</span>
				</button>}
				<div style={{ height: rowStart * 32 }} />
				{visibleEntries.slice(rowStart, rowEnd).map(entry => <div key={entry.path} role="treeitem" aria-selected={entry.path === path} aria-expanded={entry.kind === "directory" ? expanded.has(entry.path) : undefined} className={`wiki-tree-row ${entry.path === path ? "selected" : ""}`} style={{ paddingLeft: 6 + (entry.path.split("/").length - 1) * 18 }} title={entry.path}>
					<button className="wiki-tree-main" title={entry.path} onClick={() => entry.kind === "directory" ? setExpanded(prev => { const next = new Set(prev); if (next.has(entry.path)) next.delete(entry.path); else { next.add(entry.path); void loadDirectory(entry.path); } return next; }) : open(entry.path)}>
						<span className="tree-caret">{entry.kind === "directory" && (expanded.has(entry.path) ? <FiChevronDown /> : <FiChevronRight />)}</span>
						<span className="file-tree-icon" aria-hidden="true">{entry.kind === "directory" ? <FiFolder /> : <FiFile />}</span><span className="file-name-text">{entry.name}</span>
					</button>
					{changedPaths.has(entry.path) && <i className="wiki-unread" aria-label={t("wikiUnread")} />}
					<button className="file-reference-action" title={t(entry.kind === "directory" ? "linkFolderTip" : "referenceTip")} aria-label={`${t(entry.kind === "directory" ? "linkFolderTip" : "referenceTip")} · ${entry.name}`} onClick={() => onAttach(entry.path, entry.name, entry.kind === "directory")}><FiLink /></button>
				</div>)}<div style={{ height: Math.max(0, visibleEntries.length - rowEnd) * 32 }} />
				{Object.values(directories).filter(d => d.nextOffset !== undefined && (state.limited || entries.some(e => e.symlink && d.path.startsWith(e.path))) && (!d.path || expanded.has(d.path))).map(d => <button className="wiki-load-more" key={d.path} onClick={() => void loadDirectory(d.path, d.nextOffset)}>{t("wikiLoadMore")} · {d.path || "/"}</button>)}
				{!visibleEntries.length && <p className="wiki-muted">{t("wikiNoFiles")}</p>}
			</div>
		</aside>
		<div className="wiki-main">
			<div className="wiki-document-toolbar">
				<div className="wiki-editor-toolbar-slot" ref={setEditorToolbarHost} />
				{doc?.text !== undefined && <div className="wiki-toolbar-actions">{source && <button aria-label={t(focused ? "wikiStandardWidth" : "wikiWideWidth")} title={t(focused ? "wikiStandardWidth" : "wikiWideWidth")} aria-pressed={focused} onClick={() => setFocused(!focused)}><LuMoveHorizontal /></button>}{sourceButton}</div>}
			</div>
			{errorBanner}
			{autosave.conflict && <div className="wiki-conflict" role="alert"><span>{t("wikiExternalChanged")}</span><button disabled={editorBusy} onClick={() => void load(path)}>{t("wikiReload")}</button><button disabled={editorBusy || saving} onClick={() => void autosave.keepMine()}>{t("wikiKeepMine")}</button></div>}

			<div className="wiki-scroll" ref={scrollRef} onScroll={() => setSelectionMenu(null)}>
				<div className="wiki-reading-layout">
				{loading ? <div className="wiki-empty">{t("loading")}</div> : doc ? <article className={`wiki-document ${source || doc.entry.kind === "code" ? "is-source" : ""}`} ref={article} onClick={peekImage} onMouseUp={source ? selectText : undefined} onKeyUp={source ? selectText : undefined}>
					<header className="wiki-document-heading"><h1>{metadata.title || doc.entry.name.replace(/\.(md|txt)$/i, "")}</h1><div className="wiki-document-meta"><span className="wiki-meta-chip"><FiCalendar />{updatedLabel}</span>{doc.text !== undefined && <span className="wiki-meta-chip"><FiClock />{t("wikiReadingTime", { minutes: metadata.minutes })}</span>}{metadata.tags.map(tag => <span className="wiki-meta-chip wiki-meta-tag" key={tag}>#{tag}</span>)}{(!referencesReady || backlinkCount > 0) && <button className="wiki-meta-chip wiki-meta-link" onClick={() => article.current?.querySelector(".wiki-backlinks")?.scrollIntoView({ behavior: "smooth" })}><FiLink />{referencesReady ? t("wikiCitations", { count: backlinkCount }) : t("wikiReferencesLoading")}</button>}</div>{doc?.entry.kind === "document" && properties.length > 0 && <details key={`${cwd}:${path}`} className="wiki-properties"><summary>{t("wikiProperties")}</summary><dl>{properties.map((property, index) => <div key={index}><dt>{property.key}</dt><dd><ReactMarkdown>{property.value}</ReactMarkdown></dd></div>)}</dl></details>}</header>
					{doc.text !== undefined ? (source || doc.entry.kind === "code" ? <><div className="wiki-code-hint">{doc.entry.kind === "code" && !source ? t("wikiCodeReadOnly") : t("wikiEditingSource")}</div><CodeFileEditor value={draft} name={path} readOnly={editorBusy || !doc.editable || (!source && doc.entry.kind === "code")} wrap={false} onChange={setDraft} /></> : <div className="wiki-prose md"><RichMarkdownEditor key={`${cwd}:${path}`} file={{ cwd, path }} value={draft} readOnly={editorBusy || !doc.editable} onChange={setDraft} wiki={{ toolbarHost: editorToolbarHost, focused, onWidth: () => { setFocused(!focused); setDrawer(null); }, paths, ask: text => { void ask(text); }, followLink, resolveCode: value => resolveWikiLink(path, value, paths), added: NO_ADDED_LINES }} /></div>) : doc.entry.kind === "image" ? <img className="wiki-image" src={wikiMedia(cwd, path)} alt={doc.entry.name} /> : doc.entry.kind === "pdf" ? <iframe className="wiki-pdf" title={doc.entry.name} src={wikiMedia(cwd, path)} /> : <div className="wiki-empty"><FiFile /><p>{doc.entry.name} · {Math.ceil(doc.entry.size / 1024)} KB</p>{desktopAPI?.openWikiFile ? <button onClick={() => void desktopAPI!.openWikiFile!({ clientId: getClientId(), cwd, path }).catch(e => setError(e.message))}>{t("wikiOpenDefault")}</button> : <a href={wikiMedia(cwd, path, true)} download>{t("wikiDownloadOpen")}</a>}</div>}
					{(!referencesReady || doc.backlinks.length > 0) && <section className="wiki-backlinks"><h2><FiLink />{t("wikiBacklinks")} <span>{referencesReady ? doc.backlinks.length : t("loading")}</span></h2>{doc.backlinks.slice(0, backlinkLimit).map((link, index) => <button key={`${link.path}:${index}`} onClick={() => open(link.path)}><strong>{link.path}</strong><span>{link.snippet}</span></button>)}{doc.backlinks.length > backlinkLimit && <button onClick={() => setBacklinkLimit(n => n + 100)}>{t("wikiLoadMore")}</button>}{!referencesReady && <p>{t("wikiReferencesLoading")}</p>}{referencesReady && !doc.backlinks.length && <p>{t("wikiNoBacklinks")}</p>}</section>}
				</article> : <div className="wiki-empty"><FiBookOpen /><h1>{t("wikiWelcome")}</h1><p>{t("wikiWelcomeHint")}</p><button onClick={() => setSearch(true)}>{t("wikiSearchAll")}</button></div>}
					{readingOutline}
				</div>
			</div>
			{active && state.index && (statusHost ? createPortal(<WikiIndexIndicator status={state.index} />, statusHost) : <footer className="wiki-statusbar"><WikiIndexIndicator status={state.index} /></footer>)}
		</div>
		{drawer && <aside className="wiki-changes"><header><div><h2>{t(drawer === "recent" ? "wikiRecent" : "wikiRelatedChanges")}</h2><span>{cwd.split(/[\\/]/).at(-1)}</span></div><button aria-label={t("close")} onClick={() => setDrawer(null)}><FiX /></button></header><div className="wiki-changes-scroll">{state.revisions.filter(r => drawer === "recent" || r.id === drawer).map((revision, index, list) => <div key={revision.id} className="wiki-revision">{(index === 0 || new Date(list[index - 1].at).toDateString() !== new Date(revision.at).toDateString()) && <time>{new Date(revision.at).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US")}</time>}<div className="wiki-revision-title"><span className={`wiki-avatar ${revision.author}`}>{revision.author === "pi" ? <img src="/icon/1a-mark.svg" alt="pi" /> : t("wikiMe")}</span><div><strong>{revision.title.split("\n")[0]}</strong><small>{new Date(revision.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {t("wikiFileCount", { count: revision.changes.length })}</small></div></div><div className="wiki-revision-actions"><button disabled={busy || revision.changes.every(c => c.undone)} onClick={() => void restore(revision, true)}><FiCornerUpLeft />{t("wikiUndoAll")}</button><button disabled={busy || revision.changes.every(c => !c.undone)} onClick={() => void restore(revision, false)}><FiCornerUpRight />{t("wikiRedoAll")}</button></div>{revision.changes.map(summary => { const change = { ...summary, ...(fullChanges[`${revision.id}:${summary.path}`] ?? {}), undone: summary.undone }; return <div className={`wiki-file-change ${change.undone ? "undone" : ""}`} key={change.path}><div><button title={change.path} onClick={() => open(change.path)}>{change.path}</button><button disabled={busy} onClick={() => void restore(revision, !change.undone, change.path)}>{t(change.undone ? "wikiRedo" : "wikiUndo")}</button></div><small><em>+{change.additions}</em> <b>−{change.deletions}</b></small><details onToggle={e => { if (e.currentTarget.open && change.truncated) void wikiRequest<WikiChange>(cwd, "change", { id: revision.id, path: change.path }).then(result => { if (alive.current) setFullChanges(previous => ({ ...previous, [`${revision.id}:${change.path}`]: result })); }).catch(e => setError(e.message)); }}><summary>{t("wikiViewDiff")}</summary>{change.binary ? <p>{t("wikiBinaryChange")}</p> : <><pre className="wiki-diff-before">{change.before ?? t("wikiNewFile")}</pre><pre className="wiki-diff-after">{change.after ?? t("wikiDeletedFile")}</pre></>}</details></div>; })}{revision.skipped.length > 0 && <p className="wiki-skipped">{t("wikiUntracked")}: {revision.skipped.join(", ")}</p>}</div>)}{!state.revisions.length && <p className="wiki-muted">{t("wikiNoChanges")}</p>}</div></aside>}
		{selectionMenu && createPortal(<div className="wiki-selection-menu" style={{ left: selectionMenu.x, top: selectionMenu.y }} onMouseDown={e => e.preventDefault()}><button onClick={() => { void ask(selectionMenu.text); setSelectionMenu(null); }}>{t("wikiAskPi")}</button></div>, document.querySelector(".wiki-document-dialog") ?? document.body)}
		{search && <div className="wiki-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSearch(false); }}><section ref={searchDialogRef} className="wiki-search-modal" role="dialog" aria-modal="true" aria-label={t("wikiSearchAll")}><div><FiSearch /><input autoFocus aria-label={t("wikiSearchAll")} placeholder={t("wikiSearchHint")} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setCursor(i => Math.max(0, Math.min(results.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); } if (e.key === "Enter" && results[cursor]) { e.preventDefault(); if (e.metaKey || e.ctrlKey) attachResult(results[cursor]); else open(results[cursor].path); } }} /><button aria-label={t("close")} onClick={() => setSearch(false)}><FiX /></button></div><div className="wiki-search-results">{searching && <p role="status">{t("loading")}</p>}{results.map((result, i) => <div key={`${result.path}:${result.line}:${i}`}>{(i === 0 || results[i - 1].kind !== result.kind) && <h3>{t(result.kind === "document" ? "wikiDocuments" : result.kind === "pdf" ? "wikiPdf" : result.kind === "code" ? "wikiCode" : "wikiFiles")}</h3>}<button className={cursor === i ? "selected" : ""} onMouseEnter={() => setCursor(i)} onClick={e => e.metaKey || e.ctrlKey ? attachResult(result) : open(result.path)}><strong>{result.path}{result.page ? ` · ${t("wikiPage", { page: result.page })}` : ""}</strong><span>{result.snippet}</span></button></div>)}{query && !searching && !results.length && <p>{t("wikiNoResults")}</p>}{searchLimited && <p>{t("wikiSearchLimited")}</p>}</div><footer>{t("wikiSearchKeys")}</footer></section></div>}
		{nav && <div className="wiki-modal-backdrop"><section ref={navigationDialogRef} className="wiki-confirm" role="dialog" aria-modal="true" aria-label={t("wikiUnsaved")}><h2>{t("wikiUnsaved")}</h2><p>{t("wikiUnsavedHint")}</p><div><button disabled={saving} onClick={() => setNav(null)}>{t("cancel")}</button><button disabled={saving} onClick={() => { const next = nav; setDraft(doc?.text ?? ""); setNav(null); next(); }}>{t("wikiDiscard")}</button><button disabled={busy} onClick={() => void (async () => { if (await save()) { const next = nav; setNav(null); next(); } })()}>{t("wikiSaveContinue")}</button></div></section></div>}
		{zoomImage && <WikiImageZoom image={zoomImage} onClose={() => setZoomImage(null)} />}
	</section>;
}
