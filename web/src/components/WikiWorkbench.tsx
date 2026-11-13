import { isKnowledgeLibraryWindow } from "../wiki-window";
import type { WikiCoordinator } from "../wiki-coordinator";
import { WikiReadingOutline } from "../wiki-reading-outline";
import { useDialogFocus } from "../use-dialog-focus";
import { wikiProperties } from "../wiki-properties";
import ReactMarkdown from "react-markdown";
import { useContext, useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { FiPlus, FiCalendar, FiBookOpen, FiChevronDown, FiChevronRight, FiFile, FiFolder, FiFolderPlus, FiRefreshCw, FiSearch, FiX, FiClock, FiCornerUpLeft, FiCornerUpRight, FiTrash2 } from "react-icons/fi";
import { useI18n, useT } from "../i18n";
import type { WikiState, WikiDirectory, WikiDocument, WikiDocumentContent, WikiDocumentReferences, WikiRevision, WikiChange, WikiSearchResult } from "../types";
import { wikiRequest, wikiMedia } from "../wiki-api";
import { wikiMetadata, resolveWikiLink, explicitWikiFilePath } from "../wiki-document";
import { WikiResizeHandle, useWikiPanelWidth } from "./WikiResizeHandle";
import { CreateFileForm } from "./CreateFileForm";
import type { CurrentFileContext, ReadCurrentFile, SaveCurrentFile } from "../current-file";
import type { ChatReferenceRequest } from "../chat-reference";
import { RichMarkdownEditor } from "./RichMarkdownEditor";
import { DocumentReading } from "./DocumentReading";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import { CodeFileEditor } from "./CodeFileEditor";
import { desktopAPI, registerWindowSave } from "../desktop";
import { getClientId } from "../use-chat";
import { WikiIndexIndicator } from "./WikiReading";
import { WikiImageZoom } from "./WikiImageZoom";
import { useWikiAutosave } from "../use-wiki-autosave";
import { randomUuid } from "../uuid";

type Guard = (next: () => void, cancel?: () => void) => void;
const EMPTY: WikiState = { entries: [], tags: [], revisions: [], running: false, limited: false };
const NO_ADDED_LINES = new Set<string>();
const readingPositions = new Map<string, number>();
export function WikiWorkbench({ coordinator, cwd, conversationId, streaming, active, ready, guard, fileRequest, openDocument, onOpenFolder, folderBusy, connected, writingBlocked, onReference, saveBeforePrompt, contextReader, contextSaver, onContextChange }: {
	coordinator?: WikiCoordinator;
	cwd: string; conversationId: string; streaming: boolean; active: boolean; ready: boolean;
	fileRequest: {path:string;token:string}; writingBlocked: boolean; connected: boolean;
	openDocument: (path: string | null) => Promise<void>;
	onOpenFolder: () => void;
	folderBusy: boolean;
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
	const [loading, setLoading] = useState(false), [restoring, setRestoring] = useState(false);
	const [error, setError] = useState(""), [nav, setNav] = useState<(() => void) | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [sidebarWidth, resizeSidebar] = useWikiPanelWidth("sidebar");
	const [focused, setFocused] = useState(false);
	const [editorToolbarHost, setEditorToolbarHost] = useState<HTMLDivElement | null>(null);
	const readingOutline = useContext(WikiReadingOutline);
	const scrollRef = useRef<HTMLDivElement>(null);
	const treeRef = useRef<HTMLDivElement>(null);
	const [creating, setCreating] = useState<{ kind: "file" | "directory"; parent: string } | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<{ path: string; name: string; kind: "file" | "directory" } | null>(null);
	const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState("");
	const deleteDialogRef = useDialogFocus<HTMLElement>(active && !!deleteTarget);
	const createRowRef = useRef<HTMLDivElement>(null);
	useEffect(() => setCreating(null), [active, conversationId]);
	useEffect(() => {
		if (!creating) return;
		const closeOutside = (event: PointerEvent) => { if (!createRowRef.current?.contains(event.target as Node)) setCreating(null); };
		document.addEventListener("pointerdown", closeOutside);
		return () => document.removeEventListener("pointerdown", closeOutside);
	}, [creating]);
	const beginCreate = (kind: "file" | "directory", parent: string) => {
		if (parent) {
			setExpanded(prev => new Set(prev).add(parent));
			void loadDirectory(parent);
		} else {
			treeRef.current?.scrollTo({ top: 0 });
			setTreeScroll(0);
		}
		setCreating({ kind, parent });
	};
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
	const visibleEntries = useMemo(() => entries.filter(e => e.path.split("/").slice(0, -1).every((_, i, parts) => expanded.has(parts.slice(0, i + 1).join("/")))), [entries, expanded]);
	const treeRows: Array<(typeof visibleEntries)[number] | null> = [...visibleEntries];
	if (creating) {
		const index = creating.parent ? treeRows.findIndex(entry => entry?.path === creating.parent) : -1;
		if (index >= 0 || !creating.parent) treeRows.splice(index + 1, 0, null);
	}
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
		setFocused(false); setDrawer(null); setPath(fileRequest.path); setSearch(false); setSelectionMenu(null); setZoomImage(null);
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
	const syncStatus = useRef({ saving, loading });
	syncStatus.current = { saving, loading };
	useEffect(() => {
		if (!active || !path) return;
		let cancelled = false, pending = false;
		const syncDocument = async () => {
			const before = docRef.current;
			if (pending || !before || before.entry.path !== path || syncStatus.current.saving || syncStatus.current.loading) return;
			const sequence = docSequence.current;
			pending = true;
			try {
				// Read the opened file directly: the index and pi history can lag behind writes.
				const latest = await wikiRequest<WikiDocumentContent>(cwd, "document-content", { path });
				if (cancelled || !alive.current || sequence !== docSequence.current || docRef.current?.version !== before.version || syncStatus.current.saving) return;
				if (latest.version === before.version) return;
				if (draftRef.current !== before.text && before.editable) { autosave.noteExternalChange(); return; }
				const next = { ...latest, backlinks: before.backlinks };
				docRef.current = next;
				draftRef.current = latest.text ?? "";
				setDoc(next); setDraft(draftRef.current);
				void loadReferences(path, sequence);
			} catch (e) {
				if (!cancelled && alive.current && sequence === docSequence.current) setError((e as Error).message);
			} finally { pending = false; }
		};
		void syncDocument();
		const timer = setInterval(() => void syncDocument(), streaming || state.running ? 1000 : 30000);
		return () => { cancelled = true; clearInterval(timer); };
	}, [active, path, cwd, streaming, state.running, state.entries, loadReferences, autosave.noteExternalChange]);

	useEffect(() => {
		if (!nav) return;
		const previous = document.activeElement;
		document.querySelector<HTMLElement>(".wiki-confirm button")?.focus();
		return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
	}, [nav]);
	const navigationPending = useRef(false);
	const cancelNavigation = useRef<(() => void) | null>(null);
	const navigate = useCallback((next: () => void, cancel?: () => void, held = false) => {
		if (navigationPending.current) { cancel?.(); return; }
		const operation = held ? null : coordinator?.begin();
		if (!held && coordinator && !operation) { cancel?.(); return; }
		navigationPending.current = true;
		const finish = () => { navigationPending.current = false; operation?.release(); cancelNavigation.current = null; };
		const proceed = () => { finish(); next(); };
		cancelNavigation.current = () => { finish(); cancel?.(); };
		if (dirty || saving) void save().then(ok => {
			if (!alive.current) { cancelNavigation.current?.(); return; }
			if (ok) proceed(); else setNav(() => proceed);
		}).catch(() => { cancelNavigation.current?.(); });
		else proceed();
	}, [dirty, saving, save, coordinator]);
	useEffect(() => { guard.current = dirty || saving ? (next, cancel) => navigate(next, cancel, true) : null; return () => { guard.current = null; }; }, [guard, navigate, dirty, saving]);
	useEffect(() => () => { cancelNavigation.current?.(); }, []);
	useEffect(() => { const leave = (e: BeforeUnloadEvent) => { if (dirty) { void save(); e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave); }, [dirty, save]);
	const open = (target: string) => {
		if (target !== path) { void openDocument(target); return; }
		navigate(() => {
			setPath(target); setSearch(false); setSelectionMenu(null);
			setExpanded(prev => { const next = new Set(prev), parts = target.split("/"); for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/")); return next; });
			if (target === path) void load(target, true);
		});
	};

	useEffect(() => {
		if (!active) return;
		const key = (e: KeyboardEvent) => {

			if (e.defaultPrevented) return;

			if ((e.metaKey || e.ctrlKey) && ["k", "p"].includes(e.key.toLowerCase())) { e.preventDefault(); setSearch(s => !s); }
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!editorBusy) void save(); }
			if (e.key === "Escape" && (nav || search || selectionMenu || drawer)) {
				e.preventDefault();
				if (nav) { cancelNavigation.current?.(); setNav(null); } else if (search) setSearch(false); else if (selectionMenu) setSelectionMenu(null); else if (drawer) setDrawer(null);
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
	const deleteEntry = async () => {
		if (!deleteTarget || deleting || busy) return;
		const target = deleteTarget;
		const affectsCurrent = path === target.path || (target.kind === "directory" && path.startsWith(`${target.path}/`));
		setDeleting(true); setDeleteError("");
		try {
			if (affectsCurrent && (dirty || saving) && !await save()) { setDeleteError(t("wikiDeleteSaveFailed")); return; }
			await wikiRequest(cwd, "delete-entry", { path: target.path, kind: target.kind, conversationId });
			if (!alive.current) return;
			setDirectories({});
			setExpanded(previous => new Set([...previous].filter(item => item !== target.path && !item.startsWith(`${target.path}/`))));
			setDeleteTarget(null);
			await refresh(true);
			void loadDirectory("");
			if (affectsCurrent) {
				const fallback = entries.find(entry => entry.kind === "document" && entry.path !== target.path && !entry.path.startsWith(`${target.path}/`));
				await openDocument(fallback?.path ?? null);
			}
		} catch (error) { if (alive.current) setDeleteError((error as Error).message); }
		finally { if (alive.current) setDeleting(false); }
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
	const visibleRevisions = state.revisions.filter(revision => drawer === "recent" || revision.id === drawer);
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
			<button className="file-search-trigger" aria-label={t(isKnowledgeLibraryWindow ? "knowledgeChangeFolder" : "wikiOpenFolder")} title={`${t(isKnowledgeLibraryWindow ? "knowledgeChangeFolder" : "wikiOpenFolder")} · ${cwd}`} disabled={folderBusy} onClick={onOpenFolder}><FiFolder /><span>{t(isKnowledgeLibraryWindow ? "knowledgeChangeFolder" : "wikiOpenFolder")}</span></button>
			<button className="wiki-search-trigger file-search-trigger" onClick={() => setSearch(true)}><FiSearch /><span>{t("fileTreeSearch")}</span><kbd>{navigator.platform.includes("Mac") ? "⌘ P" : "Ctrl P"}</kbd></button>
			<div className="wiki-tree-label"><span>{t("wikiFiles")}</span><div className="wiki-tree-actions"><button aria-label={t("newWorkspaceFolder")} title={t("newWorkspaceFolder")} disabled={writingBlocked || !connected || state.running} onClick={() => beginCreate("directory", "")}><FiFolderPlus /></button><button aria-label={t("newWorkspaceFile")} title={t("newWorkspaceFile")} disabled={writingBlocked || !connected || state.running} onClick={() => beginCreate("file", "")}><FiPlus /><span>{t("newWorkspaceFile")}</span></button><button aria-label={t("wikiRefresh")} title={t("wikiRefresh")} onClick={() => void refresh(true)}><FiRefreshCw /></button></div></div>
			<div ref={treeRef} className="wiki-tree" role="tree" aria-label={t("wikiFiles")} onScroll={e => setTreeScroll(e.currentTarget.scrollTop)}>
				<div style={{ height: rowStart * 32 }} />
				{treeRows.slice(rowStart, rowEnd).map(entry => entry ? <div key={entry.path} role="treeitem" aria-selected={entry.path === path} aria-expanded={entry.kind === "directory" ? expanded.has(entry.path) : undefined} className={`wiki-tree-row ${entry.path === path ? "selected" : ""}`} style={{ paddingLeft: 6 + (entry.path.split("/").length - 1) * 18 }} title={entry.path}>
					<button className="wiki-tree-main" title={entry.path} onClick={() => entry.kind === "directory" ? setExpanded(prev => { const next = new Set(prev); if (next.has(entry.path)) next.delete(entry.path); else { next.add(entry.path); void loadDirectory(entry.path); } return next; }) : open(entry.path)}>
						<span className="tree-caret">{entry.kind === "directory" && (expanded.has(entry.path) ? <FiChevronDown /> : <FiChevronRight />)}</span>
						{entry.kind === "directory" ? <FiFolder className="tree-entry-icon tree-icon-folder" aria-hidden="true" /> : <FiFile className={`tree-entry-icon tree-icon-${entry.kind === "document" || entry.kind === "pdf" ? "document" : entry.kind === "code" ? "code" : entry.kind === "image" ? "media" : "default"}`} aria-hidden="true" />}<span className="file-name-text">{entry.name}</span>
					</button>
					{changedPaths.has(entry.path) && <i className="wiki-unread" aria-label={t("wikiUnread")} />}
					{entry.kind === "directory" && <button className="wiki-create-in-folder" title={t("newWorkspaceFile")} aria-label={`${t("newWorkspaceFile")} · ${entry.name}`} disabled={writingBlocked || !connected || state.running} onClick={() => beginCreate("file", entry.path)}><FiPlus /></button>}
					{entry.kind === "directory" && <button className="wiki-create-in-folder" title={t("newWorkspaceFolder")} aria-label={`${t("newWorkspaceFolder")} · ${entry.name}`} disabled={writingBlocked || !connected || state.running} onClick={() => beginCreate("directory", entry.path)}><FiFolderPlus /></button>}
					<button className="wiki-delete-entry" title={t(entry.kind === "directory" ? "wikiDeleteFolder" : "wikiDeleteFile")} aria-label={`${t(entry.kind === "directory" ? "wikiDeleteFolder" : "wikiDeleteFile")} · ${entry.name}`} disabled={busy || deleting} onClick={() => { setDeleteError(""); setDeleteTarget({ path: entry.path, name: entry.name, kind: entry.kind === "directory" ? "directory" : "file" }); }}><FiTrash2 /></button>
				</div> : creating ? <div key={`create:${creating.parent}:${creating.kind}`} ref={createRowRef} role="treeitem" className="wiki-tree-row wiki-tree-create-row" style={{ paddingLeft: 6 + (creating.parent ? creating.parent.split("/").length : 0) * 18 }}><CreateFileForm inline cwd={cwd} conversationId={conversationId} kind={creating.kind} parentPath={creating.parent} disabled={writingBlocked || !connected || state.running} onCancel={() => setCreating(null)} onCreated={target => { const { kind, parent } = creating; setCreating(null); void refresh(true); if (kind === "directory") setExpanded(prev => new Set([...prev, parent, target].filter(Boolean))); else open(target); }} /></div> : null)}<div style={{ height: Math.max(0, treeRows.length - rowEnd) * 32 }} />
				{Object.values(directories).filter(d => d.nextOffset !== undefined && (state.limited || entries.some(e => e.symlink && d.path.startsWith(e.path))) && (!d.path || expanded.has(d.path))).map(d => <button className="wiki-load-more" key={d.path} onClick={() => void loadDirectory(d.path, d.nextOffset)}>{t("wikiLoadMore")} · {d.path || "/"}</button>)}
				{!treeRows.length && <p className="wiki-muted">{t("wikiNoFiles")}</p>}
			</div>
		</aside>
		{deleteTarget && <div className="wiki-modal-backdrop"><section ref={deleteDialogRef} className="wiki-confirm wiki-entry-delete-dialog" role="dialog" aria-modal="true" aria-label={t(deleteTarget.kind === "directory" ? "wikiDeleteFolder" : "wikiDeleteFile")} onKeyDown={event => { if (event.key === "Escape" && !deleting) { event.stopPropagation(); setDeleteTarget(null); } }}>
			<h2>{t(deleteTarget.kind === "directory" ? "wikiDeleteFolder" : "wikiDeleteFile")}</h2>
			<p>{t(deleteTarget.kind === "directory" ? "wikiDeleteFolderHint" : "wikiDeleteFileHint", { name: deleteTarget.name })}</p>
			<code className="wiki-delete-path">{deleteTarget.path}</code>
			{deleteError && <p className="wiki-delete-error" role="alert">{deleteError}</p>}
			<div><button type="button" disabled={deleting} onClick={() => setDeleteTarget(null)}>{t("cancel")}</button><button type="button" disabled={deleting} onClick={() => void deleteEntry()}>{deleting ? t("wikiDeleting") : t("delete")}</button></div>
		</section></div>}
		<div className="wiki-main">
			<div className="wiki-document-toolbar">
				<div className="wiki-editor-toolbar-slot" ref={setEditorToolbarHost} />
				{/* 源码切换已移除：Markdown 始终是富文本编辑，代码文件始终只读，没有可切换的状态。 */}
			</div>
			{errorBanner}
			{autosave.conflict && <div className="wiki-conflict" role="alert"><span>{t("wikiExternalChanged")}</span><button disabled={editorBusy} onClick={() => void load(path)}>{t("wikiReload")}</button><button disabled={editorBusy || saving} onClick={() => void autosave.keepMine()}>{t("wikiKeepMine")}</button></div>}

			<div className="wiki-scroll" ref={scrollRef} onScroll={() => setSelectionMenu(null)}>
				<div className="wiki-reading-layout">
				{loading ? <div className="wiki-empty">{t("loading")}</div> : doc ? <DocumentReading
						articleRef={article}
						title={metadata.title || doc.entry.name.replace(/\.(md|txt)$/i, "")}
						chips={[
							{ icon: "calendar", label: updatedLabel },
							...(doc.text !== undefined ? [{ icon: "clock" as const, label: t("wikiReadingTime", { minutes: metadata.minutes }) }] : []),
							...metadata.tags.map(tag => ({ icon: "tag" as const, label: `#${tag}` })),
							...(!referencesReady || backlinkCount > 0 ? [{ icon: "citations" as const, label: referencesReady ? t("wikiCitations", { count: backlinkCount }) : t("wikiReferencesLoading"), onClick: () => article.current?.querySelector(".wiki-backlinks")?.scrollIntoView({ behavior: "smooth" }) }] : []),
						]}
						properties={doc.entry.kind === "document" && properties.length > 0 ? <details key={`${cwd}:${path}`} className="wiki-properties"><summary>{t("wikiProperties")}</summary><dl>{properties.map((property, index) => <div key={index}><dt>{property.key}</dt><dd><ReactMarkdown>{property.value}</ReactMarkdown></dd></div>)}</dl></details> : null}
						/* Code files have no rich rendering: the read-only source editor is their body. */
						source={doc.entry.kind === "code"}
						sourceLabel={doc.entry.kind === "code" ? t("wikiCodeReadOnly") : ""}
						sourceEditor={<CodeFileEditor value={draft} name={path} readOnly={editorBusy || !doc.editable} wrap={false} onChange={setDraft} />}
						editor={<div className="wiki-prose md"><RichMarkdownEditor key={`${cwd}:${path}`} file={{ cwd, path }} value={draft} readOnly={editorBusy || !doc.editable} onChange={setDraft} documentHost={{ toolbar: editorToolbarHost ? { host: editorToolbarHost, variant: "wiki" } : undefined, width: { focused, onToggle: () => { setFocused(!focused); setDrawer(null); } }, links: { paths, open: followLink }, ask: text => { void ask(text); }, resolveCode: value => resolveWikiLink(path, value, paths), added: NO_ADDED_LINES }} /></div>}
						backlinks={doc.backlinks.slice(0, backlinkLimit)}
						backlinksReady={referencesReady}
						onShowMoreBacklinks={doc.backlinks.length > backlinkLimit ? () => setBacklinkLimit(n => n + 100) : undefined}
						onMouseUp={doc.entry.kind === "code" ? selectText : peekImage}
						onKeyUp={doc.entry.kind === "code" ? selectText : undefined}
					/>
				: <div className="wiki-empty"><FiBookOpen /><h1>{t("wikiWelcome")}</h1><p>{t("wikiWelcomeHint")}</p><button onClick={() => setSearch(true)}>{t("wikiSearchAll")}</button></div>}
					{readingOutline}
				</div>
			</div>
			{active && state.index && (statusHost ? createPortal(<WikiIndexIndicator status={state.index} />, statusHost) : <footer className="wiki-statusbar"><WikiIndexIndicator status={state.index} /></footer>)}
		</div>
		{drawer && <aside className="wiki-changes" aria-label={t(drawer === "recent" ? "wikiRecent" : "wikiRelatedChanges")}>
			<header><div><h2>{t(drawer === "recent" ? "wikiRecent" : "wikiRelatedChanges")}</h2><span>{cwd.split(/[\\/]/).at(-1)} · {t("wikiChangeCount", { count: visibleRevisions.length })}</span></div><button aria-label={t("close")} onClick={() => setDrawer(null)}><FiX /></button></header>
			<div className="wiki-changes-scroll">{visibleRevisions.map((revision, index, list) => <section key={revision.id} className="wiki-revision">
				{(index === 0 || new Date(list[index - 1].at).toDateString() !== new Date(revision.at).toDateString()) && <time>{new Date(revision.at).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "long", day: "numeric" })}</time>}
				<div className="wiki-revision-card"><div className="wiki-revision-title"><span className={`wiki-avatar ${revision.author}`}>{revision.author === "pi" ? <img src="/icon/1a-mark.svg" alt="pi" /> : t("wikiMe")}</span><div><strong>{revision.changes.length === 1 && revision.title.split("\n")[0] === revision.changes[0].path ? t("wikiSavedChange") : revision.title.split("\n")[0]}</strong><small>{new Date(revision.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {t("wikiFileCount", { count: revision.changes.length })}</small></div></div>
					{revision.changes.length > 1 && <div className="wiki-revision-actions"><button disabled={busy || revision.changes.every(c => c.undone)} onClick={() => void restore(revision, true)}><FiCornerUpLeft />{t("wikiUndoAll")}</button><button disabled={busy || revision.changes.every(c => !c.undone)} onClick={() => void restore(revision, false)}><FiCornerUpRight />{t("wikiRedoAll")}</button></div>}
					{revision.changes.map(summary => { const change = { ...summary, ...(fullChanges[`${revision.id}:${summary.path}`] ?? {}), undone: summary.undone }; return <div className={`wiki-file-change ${change.undone ? "undone" : ""}`} key={change.path}><div className="wiki-file-change-head"><button className="wiki-change-file" title={change.path} onClick={() => open(change.path)}><FiFile /><span>{change.path}</span></button><button className="wiki-change-restore" disabled={busy} onClick={() => void restore(revision, !change.undone, change.path)}>{change.undone ? <FiCornerUpRight /> : <FiCornerUpLeft />}{t(change.undone ? "wikiRedo" : "wikiUndo")}</button></div><div className="wiki-file-change-meta"><span><em>+{change.additions}</em><b>−{change.deletions}</b></span>{change.undone && <span className="wiki-change-undone">{t("wikiUndone")}</span>}</div><details onToggle={e => { if (e.currentTarget.open && change.truncated) void wikiRequest<WikiChange>(cwd, "change", { id: revision.id, path: change.path }).then(result => { if (alive.current) setFullChanges(previous => ({ ...previous, [`${revision.id}:${change.path}`]: result })); }).catch(e => setError(e.message)); }}><summary>{t("wikiViewDiff")}</summary>{change.binary ? <p>{t("wikiBinaryChange")}</p> : <div className="wiki-diff-versions"><div><span className="wiki-diff-label before">{t("wikiBefore")}</span><pre className="wiki-diff-before">{change.before ?? t("wikiNewFile")}</pre></div><div><span className="wiki-diff-label after">{t("wikiAfter")}</span><pre className="wiki-diff-after">{change.after ?? t("wikiDeletedFile")}</pre></div></div>}</details></div>; })}
					{revision.skipped.length > 0 && <p className="wiki-skipped">{t("wikiUntracked")}: {revision.skipped.join(", ")}</p>}
				</div></section>)}{!visibleRevisions.length && <p className="wiki-muted">{t("wikiNoChanges")}</p>}</div>
		</aside>}
		{selectionMenu && createPortal(<div className="wiki-selection-menu" style={{ left: selectionMenu.x, top: selectionMenu.y }} onMouseDown={e => e.preventDefault()}><button onClick={() => { void ask(selectionMenu.text); setSelectionMenu(null); }}>{t("wikiAskPi")}</button></div>, document.querySelector(".wiki-document-dialog") ?? document.body)}
		{search && <div className="wiki-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSearch(false); }}><section ref={searchDialogRef} className="wiki-search-modal" role="dialog" aria-modal="true" aria-label={t("wikiSearchAll")}><div><FiSearch /><input autoFocus aria-label={t("wikiSearchAll")} placeholder={t("wikiSearchHint")} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setCursor(i => Math.max(0, Math.min(results.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); } if (e.key === "Enter" && results[cursor]) { e.preventDefault(); if (e.metaKey || e.ctrlKey) attachResult(results[cursor]); else open(results[cursor].path); } }} /><button aria-label={t("close")} onClick={() => setSearch(false)}><FiX /></button></div><div className="wiki-search-results">{searching && <p role="status">{t("loading")}</p>}{results.map((result, i) => <div key={`${result.path}:${result.line}:${i}`}>{(i === 0 || results[i - 1].kind !== result.kind) && <h3>{t(result.kind === "document" ? "wikiDocuments" : result.kind === "pdf" ? "wikiPdf" : result.kind === "code" ? "wikiCode" : "wikiFiles")}</h3>}<button className={cursor === i ? "selected" : ""} onMouseEnter={() => setCursor(i)} onClick={e => e.metaKey || e.ctrlKey ? attachResult(result) : open(result.path)}><strong>{result.path}{result.page ? ` · ${t("wikiPage", { page: result.page })}` : ""}</strong><span>{result.snippet}</span></button></div>)}{query && !searching && !results.length && <p>{t("wikiNoResults")}</p>}{searchLimited && <p>{t("wikiSearchLimited")}</p>}</div><footer>{t("wikiSearchKeys")}</footer></section></div>}
		{nav && <UnsavedChangesDialog dialogRef={navigationDialogRef} saving={saving} busy={busy} onCancel={() => { cancelNavigation.current?.(); setNav(null); }} onDiscard={() => { const next = nav; setDraft(doc?.text ?? ""); setNav(null); next(); }} onSave={() => void (async () => { if (await save()) { const next = nav; setNav(null); next(); } })()} />}
		{zoomImage && <WikiImageZoom image={zoomImage} onClose={() => setZoomImage(null)} />}
	</section>;
}
