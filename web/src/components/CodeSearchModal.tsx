import { useDialogFocus } from "../use-dialog-focus";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiFileText, FiSearch, FiX } from "react-icons/fi";
import type { ClientMessage, ContentSearchMatch, FileSearchResult, ServerMessage } from "../types";
import { getClientId, SEARCH_CONTENT_EVENT } from "../use-chat";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { groupMatches, highlightPattern, previewWindow, splitByRanges, type SearchToggles } from "../code-search-view";

let searchSequence = Date.now();
const nextRequestId = () => ++searchSequence;

type Mode = "code" | "file";
type ContentResult = Extract<ServerMessage, { type: "search_content_result" }>;

interface CodeSearchModalProps {
	send: (msg: ClientMessage) => boolean;
	cwd: string;
	fileSearch: { reqId: number; ok: boolean; results: FileSearchResult[]; truncated?: boolean } | null;
	onClose: () => void;
	onPreviewFile: (path: string, name: string) => void;
}

/** Workspace file text for the preview pane; cached per dialog, read through the authenticated file route. */
function useFileLines(cwd: string) {
	const cache = useRef(new Map<string, Promise<string[] | null>>());
	return useCallback((path: string) => {
		const key = `${cwd}\0${path}`;
		let pending = cache.current.get(key);
		if (!pending) {
			const url = withToken(`/api/file?clientId=${encodeURIComponent(getClientId())}&cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&download=1`);
			pending = fetch(url).then(response => response.ok ? response.text() : null).then(text => text === null ? null : text.replace(/\r\n/g, "\n").split("\n")).catch(() => null);
			cache.current.set(key, pending);
		}
		return pending;
	}, [cwd]);
}

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
	return <>{splitByRanges(text, ranges).map((part, index) => part.hit ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>)}</>;
}

/**
 * ⌘P search (code-search guide, step 1): code mode streams ripgrep matches grouped by file with a
 * preview around the hit; file-name mode keeps the original filename search.
 */
export function CodeSearchModal({ send, cwd, fileSearch, onClose, onPreviewFile }: CodeSearchModalProps) {
	const t = useT();
	const dialogRef = useDialogFocus();
	const inputRef = useRef<HTMLInputElement>(null);
	const [mode, setMode] = useState<Mode>("code");
	const [query, setQuery] = useState("");
	const [toggles, setToggles] = useState<SearchToggles>({ caseSensitive: false, wholeWord: false, regex: false });
	const [include, setInclude] = useState("");
	const [active, setActive] = useState(0);
	const [matches, setMatches] = useState<ContentSearchMatch[]>([]);
	const [status, setStatus] = useState<{ pending: boolean; truncated?: boolean; error?: string }>({ pending: false });
	const reqRef = useRef(0);
	const fileReqRef = useRef(0);
	const listRef = useRef<HTMLDivElement>(null);
	const readLines = useFileLines(cwd);

	const q = query.trim();
	const pattern = useMemo(() => highlightPattern(q, toggles), [q, toggles]);
	const invalidRegex = mode === "code" && !!q && toggles.regex && pattern === null;

	useEffect(() => {
		requestAnimationFrame(() => inputRef.current?.focus());
		// Closing mid-search stops ripgrep now rather than at its time limit.
		return () => { send({ type: "search_content", reqId: nextRequestId(), query: "" }); };
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
	}, []);

	// Debounced request; a new reqId makes the server kill the previous ripgrep.
	useEffect(() => {
		setActive(0);
		// Invalidate immediately, including the debounce window, mode switches and empty/invalid input.
		reqRef.current = nextRequestId();
		fileReqRef.current = 0;
		setMatches([]);
		setStatus({ pending: !!q && !invalidRegex });
		send({ type: "search_content", reqId: reqRef.current, query: "" });
		if (!q || invalidRegex) return;
		const timer = window.setTimeout(() => {
			if (mode === "code") {
				const reqId = nextRequestId();
				reqRef.current = reqId;
				setMatches([]);
				setStatus({ pending: true });
				send({ type: "search_content", reqId, query: q, ...toggles, include: include.split(",").map(glob => glob.trim()).filter(Boolean) });
			} else {
				// Time-based ids never collide with an earlier dialog's stale file results.
				const reqId = Math.max(Date.now(), fileReqRef.current + 1);
				fileReqRef.current = reqId;
				setStatus({ pending: true });
				send({ type: "search_files", reqId, query: q });
			}
		}, 300);
		return () => window.clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- send is stable
	}, [q, mode, toggles, include, invalidRegex, cwd]);

	useEffect(() => {
		const onBatch = (event: Event) => {
			const message = (event as CustomEvent<ContentResult>).detail;
			if (message.reqId !== reqRef.current || message.cwd !== cwd) return;
			if (message.matches.length) setMatches(previous => [...previous, ...message.matches]);
			if (message.done) setStatus({ pending: false, truncated: message.truncated, error: message.ok ? undefined : message.error || "" });
		};
		window.addEventListener(SEARCH_CONTENT_EVENT, onBatch);
		return () => window.removeEventListener(SEARCH_CONTENT_EVENT, onBatch);
	}, [cwd]);

	useEffect(() => { if (mode === "file" && fileSearch?.reqId === fileReqRef.current) setStatus({ pending: false, truncated: fileSearch.truncated }); }, [fileSearch, mode]);

	const groups = useMemo(() => groupMatches(matches), [matches]);
	const files = mode === "file" && q && fileSearch?.reqId === fileReqRef.current && fileSearch.ok ? fileSearch.results.filter(result => result.type === "file") : [];
	const flat: { path: string; line: number; match?: ContentSearchMatch }[] = mode === "code" ? groups.flatMap(group => group.matches.map(match => ({ path: match.path, line: match.line, match }))) : files.map(file => ({ path: file.path, line: 1 }));
	const selected = flat[Math.min(active, flat.length - 1)];

	const open = useCallback((item: typeof selected) => {
		if (!item) return;
		if (mode === "code") window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", { detail: { path: item.path, line: item.line } }));
		else onPreviewFile(item.path, item.path.split("/").at(-1) ?? item.path);
		onClose();
	}, [mode, onPreviewFile, onClose]);

	const switchMode = useCallback(() => { setMode(current => current === "code" ? "file" : "code"); setActive(0); inputRef.current?.focus(); }, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
			else if (event.key === "ArrowDown") { event.preventDefault(); setActive(index => Math.max(0, Math.min(index + 1, flat.length - 1))); }
			else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
			else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); open(selected); }
			else if (event.key === "Tab" && event.target === inputRef.current) { event.preventDefault(); switchMode(); }
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [flat.length, selected, open, onClose, switchMode]);

	// Keep the active row visible while moving with the keyboard.
	useEffect(() => { listRef.current?.querySelector(".cs-row.active")?.scrollIntoView({ block: "nearest" }); }, [active]);

	const [preview, setPreview] = useState<{ path: string; start: number; lines: string[] } | null | "unavailable">(null);
	useEffect(() => {
		if (!selected) { setPreview(null); return; }
		let live = true;
		void readLines(selected.path).then(lines => {
			if (!live) return;
			if (!lines) { setPreview("unavailable"); return; }
			const window_ = mode === "code" ? previewWindow(lines.length, selected.line) : { start: 1, end: Math.min(lines.length, 40) };
			setPreview({ path: selected.path, start: window_.start, lines: lines.slice(window_.start - 1, window_.end) });
		});
		return () => { live = false; };
	}, [selected?.path, selected?.line, mode, readLines]);

	const toggle = (key: keyof SearchToggles, label: string, glyph: ReactNode) => <button type="button" className={`cs-toggle${toggles[key] ? " on" : ""}`} aria-pressed={toggles[key]} title={label} aria-label={label} onClick={() => setToggles(current => ({ ...current, [key]: !current[key] }))}>{glyph}</button>;

	let empty: { text: string; sub?: string } | null = null;
	if (!q) empty = mode === "code" ? { text: t("csEmptyCode"), sub: t("csEmptyCodeSub") } : { text: t("treeSearchHint") };
	else if (invalidRegex) empty = { text: t("csInvalidRegex") };
	else if (status.error !== undefined) empty = { text: t("csError"), sub: status.error };
	else if (!flat.length) empty = status.pending ? { text: t("csSearching") } : { text: t("csNoResults"), sub: mode === "code" && (toggles.caseSensitive || toggles.wholeWord || include.trim()) ? t("csNoResultsSub") : undefined };

	const summary = !q ? "" : invalidRegex ? t("csInvalidRegex") : mode === "code" && matches.length ? t("csSummary", { n: matches.length, files: groups.length }) : mode === "file" && files.length ? t("csFileSummary", { n: files.length }) : "";
	let index = -1;

	return <div className="modal-backdrop gs-backdrop" onClick={onClose}>
		<div className="cs-modal" role="dialog" aria-modal="true" aria-label={t("treeSearchFiles")} ref={dialogRef} tabIndex={-1} onClick={event => event.stopPropagation()}>
			<div className="cs-head">
				<FiSearch className="cs-search-icon" aria-hidden="true" />
				<div className="cs-modes" role="tablist" aria-label={t("csSwitchMode")}>
					<button type="button" role="tab" aria-selected={mode === "code"} className={mode === "code" ? "on" : ""} onClick={() => mode !== "code" && switchMode()}>{t("csModeCode")}</button>
					<button type="button" role="tab" aria-selected={mode === "file"} className={mode === "file" ? "on" : ""} onClick={() => mode !== "file" && switchMode()}>{t("csModeFile")}</button>
				</div>
				<input ref={inputRef} type="text" value={query} spellCheck={false} aria-label={t(mode === "code" ? "csPlaceholderCode" : "treeSearchFiles")} placeholder={t(mode === "code" ? "csPlaceholderCode" : "treeSearchFiles")} onChange={event => setQuery(event.target.value)} />
				{mode === "code" && <div className="cs-toggles">
					{toggle("caseSensitive", t("csCase"), "Aa")}
					{toggle("wholeWord", t("csWord"), <u>ab</u>)}
					{toggle("regex", t("csRegex"), ".*")}
				</div>}
				<button type="button" className="gs-close" title={t("close")} aria-label={t("close")} onClick={onClose}><FiX /></button>
			</div>
			<div className="cs-scope">
				{mode === "code" ? <label><span>{t("csScope")}</span><input type="text" value={include} spellCheck={false} placeholder={t("csScopePlaceholder")} aria-label={t("csScope")} onChange={event => setInclude(event.target.value)} /></label> : <span />}
				<span className={`cs-summary${invalidRegex ? " error" : ""}`} aria-live="polite">{summary}{status.pending && flat.length ? ` · ${t("csSearching")}` : ""}</span>
			</div>
			<div className="cs-body">
				<div className="cs-results" ref={listRef}>
					{empty ? <div className="cs-empty"><p>{empty.text}</p>{empty.sub && <small>{empty.sub}</small>}</div>
						: mode === "code" ? groups.map(group => <section key={group.path} className="cs-group">
							<header><FiFileText aria-hidden="true" /><strong>{group.name}</strong><span>{group.dir}</span><em>{group.matches.length}</em></header>
							{group.matches.map(match => { index++; const own = index; return <button key={`${match.line}:${match.column}`} type="button" className={`cs-row${own === active ? " active" : ""}`} onMouseEnter={() => setActive(own)} onClick={() => open({ path: match.path, line: match.line, match })}>
								<span className="cs-line">{match.line}</span><code><Highlighted text={match.text.trimStart()} ranges={match.ranges.map(([start, end]) => { const cut = match.text.length - match.text.trimStart().length; return [start - cut, end - cut] as [number, number]; })} /></code>
							</button>; })}
						</section>)
						: files.map(file => { index++; const own = index; const name = file.path.split("/").at(-1) ?? file.path; return <button key={file.path} type="button" className={`cs-row cs-file${own === active ? " active" : ""}`} onMouseEnter={() => setActive(own)} onClick={() => open({ path: file.path, line: 1 })}>
							<FiFileText aria-hidden="true" /><strong>{pattern ? <Highlighted text={name} ranges={[...name.matchAll(new RegExp(pattern.source, "gi"))].map(hit => [hit.index!, hit.index! + hit[0].length] as [number, number])} /> : name}</strong><span>{file.path.split("/").slice(0, -1).join("/")}</span>
						</button>; })}
					{!empty && status.truncated && <div className="cs-truncated">{mode === "code" ? t("csTruncated", { n: 500 }) : t("gsTruncated")}</div>}
				</div>
				<div className="cs-preview" aria-label={selected?.path}>
					{selected && <div className="cs-preview-head"><code>{selected.path}</code>{mode === "code" && <span>{t("csLine", { n: selected.line })}</span>}</div>}
					{preview === "unavailable" ? <div className="cs-empty"><p>{t("csPreviewUnavailable")}</p></div>
						: preview && selected && preview.path === selected.path && <div className="cs-preview-code">{preview.lines.map((line, offset) => {
							const number = preview.start + offset;
							const hit = mode === "code" && number === selected.line;
							const ranges = hit && selected.match && selected.match.text === line ? selected.match.ranges : pattern && mode === "code" ? [...line.matchAll(pattern)].map(found => [found.index!, found.index! + found[0].length] as [number, number]).filter(([start, end]) => end > start) : [];
							return <div key={number} className={`cs-preview-line${hit ? " hit" : ""}`}><span>{number}</span><code><Highlighted text={line || " "} ranges={ranges} /></code></div>;
						})}</div>}
				</div>
			</div>
			<div className="gs-foot cs-foot">
				<span>↑↓ {t("gsNavigate")}</span>
				<span>Enter {t(mode === "code" ? "csOpenLine" : "gsOpen")}</span>
				<span>Tab {t("csSwitchMode")}</span>
				<span>Esc {t("gsCloseHint")}</span>
			</div>
		</div>
	</div>;
}
