import { CopyButton } from "./copy-button";
import { PlaygroundChat } from "./PlaygroundChat";
import { boundedPlaygroundOutput } from "../playground-chat-context";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import pythonLogo from "../assets/playground-python.svg";
import { FiFileText, FiPlus, FiX, FiRotateCcw, FiColumns, FiMaximize2, FiPlay, FiSquare, FiSliders, FiTerminal, FiMessageSquare } from "react-icons/fi";
import { missingPythonEditorTools, pythonFormatErrorLine } from "../playground-format-error";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { usePlaygroundHost } from "../playground-context";
import { runKey, startRun, stopRun, usePlaygroundRun } from "../playground-run-store";
import { discardExtraDraft, usePlaygroundScratch } from "../use-playground-scratch";
import { SCRATCH_EXAMPLE as EXAMPLE, EMPTY_SCRATCH_TESTS as EMPTY_TESTS } from "../playground-scratch-store";
import type { PlaygroundTestConfig, PlaygroundFormatResult } from "../types";
import { discoverPythonMethods, defaultParameterValue } from "../../../server/playground-methods";
import { PlaygroundToolsInstall } from "./PlaygroundToolsInstall";
import { ScratchOutput } from "./ScratchOutput";
import { reconcileMethodSelection } from "../playground-method-selection";
import { randomUuid } from "../uuid";
import { PlaygroundMethodCases, caseError } from "./PlaygroundMethodCases";

import type { ScratchEditorHandle } from "./scratch-editor";

const ScratchEditor = lazy(() => import("./scratch-editor").then(m => ({ default: m.ScratchEditor })));

/** Script and current parameters run sequentially against separate store keys. */
type ScratchRun = { version: string; programKey: string; casesKey: string; snapshot: string; methodId?: string; ranCases: boolean };

const recentRuns = new Map<string, ScratchRun>();
export function PlaygroundScratch() {
	const t = useT();
	const [files, setFiles] = useState<string[]>(() => JSON.parse(sessionStorage.getItem("pi-harness:playground-files") ?? '["main.py"]'));
	const [file, setFile] = useState(files[0]);
	const [names, setNames] = useState<Record<string, string>>(() => JSON.parse(sessionStorage.getItem("pi-harness:playground-names") ?? "{}"));
	const label = (id: string) => names[id] ?? id;
	function updateName(id: string, value?: string) {
		const next = { ...names };
		if (value) next[id] = value;
		else delete next[id];
		sessionStorage.setItem("pi-harness:playground-names", JSON.stringify(next));
		setNames(next);
	}
	function newDraftId() {
		let n = 1;
		while (files.includes(`draft${n}.py`) || files.some(id => label(id) === `draft${n}.py`)) n++;
		return `draft${n}.py`;
	}
	function changeFiles(next: string[], active: string) {
		sessionStorage.setItem("pi-harness:playground-files", JSON.stringify(next));
		setFiles(next);
		setFile(active);
	}
	return <ScratchFile key={file} {...{file, files, setFile, label}} rename={name => updateName(file, name)} add={() => {
		if (!files.includes("main.py")) { changeFiles([...files, "main.py"], "main.py"); return; }
		const name = newDraftId();
		changeFiles([...files, name], name);
	}} close={() => {
		if (file !== "main.py") {
			if (!window.confirm(t("pgCloseConfirm").replace("{file}", label(file)))) return;
			updateName(file);
			discardExtraDraft(file);
			recentRuns.delete(file);
		}
		const next = files.filter(name => name !== file);
		if (!next.length) next.push(file === "main.py" ? newDraftId() : "main.py");
		changeFiles(next, next[0]);
	}} />;
}
function ScratchFile({file, files, setFile, label, rename, add, close}: {label: (id: string) => string; rename: (name: string) => void; file: string; files: string[]; setFile: (name: string) => void; add: () => void; close: () => void}) {
	const nameButton = useRef<HTMLButtonElement>(null);
	const nameBox = useRef({ width: 0, height: 0 });
	const [editingName, setEditingName] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const t = useT();
	const editor = useRef<ScratchEditorHandle>(null);
	const [cursor, setCursor] = useState({ line: 1, column: 1 });
	const [resultTab, setResultTab] = useState<number>(0);
	const [chatOpened, setChatOpened] = useState(false);
	const [executing, setExecuting] = useState(false);
	const cancelled = useRef(false);
	const [language, setLanguage] = useState<{ state: "loading" | "ready" | "error"; reason?: string }>({ state: "loading" });
	const languageStatus = useCallback((state: "loading" | "ready" | "error", reason?: string) => setLanguage({ state, reason }), []);
	const [formatFailure, setFormatFailure] = useState<{ source: string; message: string; operation: "format" | "indent" } | null>(null);
	const formatController = useRef<AbortController | null>(null);
	useEffect(() => () => formatController.current?.abort(), []);
	const { status } = usePlaygroundHost();
	const { doc, edit: setDoc, save, reload, conflict, loadFailed, saveState } = usePlaygroundScratch(file);
	const formatError = formatFailure?.source === doc?.content ? formatFailure?.message ?? "" : "";
	const formatErrorLine = pythonFormatErrorLine(formatError);
	const [lastRun, setLastRun] = useState(recentRuns.get(file));
	const programRun = usePlaygroundRun(lastRun?.programKey ?? "");
	const casesRun = usePlaygroundRun(lastRun?.casesKey ?? "");
	const running = executing || programRun.phase === "running" || casesRun.phase === "running";
	const output = boundedPlaygroundOutput(lastRun ? JSON.stringify({ program: programRun, cases: lastRun.ranCases ? casesRun : undefined }) : "");
	const snapshot = doc ? JSON.stringify(doc) : "";
	const tests = doc?.tests ?? EMPTY_TESTS;
	const discovered = useMemo(() => discoverPythonMethods(doc?.content ?? ""), [doc?.content]);
	const previousMethods = useRef(discovered.methods);
	useEffect(() => {
		const timer = setTimeout(() => {
			const previous = previousMethods.current;
			setDoc(current => {
				const next = reconcileMethodSelection(current.tests, discovered.methods, previous);
				return next === current.tests ? current : { ...current, tests: next };
			});
			if (discovered.methods.length) previousMethods.current = discovered.methods;
		}, 500);
		return () => clearTimeout(timer);
	}, [discovered, setDoc]);
	const method = discovered.methods.find(m => m.id === tests.selectedMethod);
	const cases = Object.hasOwn(tests.casesByMethod, tests.selectedMethod) ? tests.casesByMethod[tests.selectedMethod] : [];

	useEffect(() => {
		if (!tests.selectedMethod && discovered.methods.length) setDoc(current => ({ ...current, tests: { ...current.tests, selectedMethod: discovered.methods[0].id } }));
	}, [tests.selectedMethod, discovered, setDoc]);

	useEffect(() => {
		if (method && !cases.length) setDoc(current => ({ ...current, tests: { ...current.tests, casesByMethod: { ...current.tests.casesByMethod, [method.id]: [{ id: randomUuid(), args: method.parameters.map(parameter => defaultParameterValue(parameter.type)) }] } } }));
	}, [method, cases.length, setDoc]);

	const reason = !status ? t("playgroundChecking") : status.locked ? t("playgroundLocked") : !status.enabled ? t("playgroundDisabled") : !status.python.available ? [t("playgroundNoPython"), status.python.reason].filter(Boolean).join(" — ") : "";
	const caseBatchError = !method ? (discovered.methods.length || cases.length ? t("pgNoMethods") : "") : caseError(method, cases.slice(0, 1));
	const start = useCallback(async () => {
		if (!doc || reason || running || !doc.content.trim() || (method && caseBatchError)) return;
		const requested = method && cases[0] ? [{ id: cases[0].id, args: cases[0].args }] : undefined;
		const invocation = randomUuid();
		const programKey = runKey(`scratch:program:${invocation}`, JSON.stringify({ code: doc.content }));
		const casesKey = runKey(`scratch:cases:${invocation}`, JSON.stringify({ code: doc.content, methodId: method?.id, cases: requested ?? [] }));
		const lastScratchRun = { version: invocation, programKey, casesKey, snapshot: JSON.stringify(doc), methodId: method?.id, ranCases: !!requested };
		recentRuns.set(file, lastScratchRun);
		setCollapsed(false);
		setResultTab(1);
		setLastRun(lastScratchRun);
		cancelled.current = false;
		setExecuting(true);
		try {
			await startRun(programKey, doc.content);
			if (requested && !cancelled.current) await startRun(casesKey, doc.content, { methodId: method!.id, cases: requested });
		} finally { setExecuting(false); }
	}, [file, doc, reason, running, cases, method, caseBatchError]);
	const stop = () => { cancelled.current = true; if (lastRun) { stopRun(lastRun.programKey); stopRun(lastRun.casesKey); } };
	const formatCode = async (saveAfter = false, operation: "format" | "indent" = "format") => {
		if (!doc) return;
		if (formatController.current) { if (saveAfter) await save(); return; }
		let source = doc.content;
		let stage = saveAfter ? "indent" as const : operation;
		const controller = new AbortController();
		formatController.current = controller;
		setFormatFailure(null);
		const transform = async (action: "format" | "indent", range = {}) => {
			const response = await fetch(withToken(`/api/playground/${action}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: source, ...range }), signal: controller.signal });
			if (!response.ok) { const error = await response.json(); throw new Error(error.error || "format failed"); }
			return await response.json() as PlaygroundFormatResult;
		};
		try {
			if (saveAfter) {
				const indented = await transform("indent");
				if (controller.signal.aborted) return;
				editor.current?.applyIndent(source, indented.code);
				source = indented.code;
				stage = "format";
			}
			const result = await transform(operation, operation === "indent" ? editor.current?.indentRange() : {});
			if (!controller.signal.aborted) {
				if (operation === "indent") editor.current?.applyIndent(source, result.code);
				else setDoc(current => current.content === source ? { ...current, content: result.code } : current);
			}
		} catch (error) {
			if (!controller.signal.aborted) setFormatFailure({ source, operation: stage, message: error instanceof Error ? error.message : String(error) });
		} finally {
			formatController.current = null;
			if (!controller.signal.aborted) {
				if (saveAfter) await save();
			}
		}
	};
	const updateTests = (patch: Partial<PlaygroundTestConfig>) => setDoc(current => current ? { ...current, tests: { ...current.tests, ...patch } } : current);

	return <div className={`scratch-page method-mode pg-studio ${expanded ? "pg-expanded" : ""}`} data-save-state={saveState}>
		<header className="scratch-head">
			<img className="pg-brand" src={pythonLogo} alt="" /><div className="pg-heading"><h2>Python Playground</h2><span>{t("pgSubtitle")}</span></div>
			<details className="pg-runtime" data-ready={!!status?.python.available}><summary>Python {status?.python.version}</summary><small>{status?.python.path || reason}</small></details>
			<button className="btn" disabled={running || !doc} onClick={() => { if (window.confirm(t("pgResetConfirm"))) setDoc({ content: EXAMPLE, tests: EMPTY_TESTS }); }}><FiRotateCcw />{t("pgReset")}</button>
			<button className="btn" title={t(collapsed ? "pgResultShow" : "pgResultHide")} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><FiColumns /></button>
			<button className="btn" title={t(expanded ? "exitFullscreen" : "fullscreen")} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><FiMaximize2 /></button>

			{saveState === "error" && <span className="scratch-save-status error" role="alert">{t("fileSaveFailed")}</span>}

		</header>
		{(reason || (method && caseBatchError)) && <p className="scratch-run-hint" role="status">{reason || t("pgParametersRequired")}</p>}
		{conflict && <div className="playground-notice" role="alert"><p>{t("pgScratchConflict")}</p><CopyButton text={JSON.stringify(doc, null, 2)} /><button className="btn" onClick={() => void reload()}>{t("pgScratchReload")}</button></div>}
		{loadFailed && <p className="playground-notice" role="alert">{t("pgLoadFailed")}</p>}
		<div className={`scratch-workspace ${collapsed ? "results-collapsed" : ""}`}>
			<section className="scratch-code-pane" aria-label={t("pgSource")}>
				<div className="scratch-pane-head"><div className="pg-files">{files.map(id => id === file && editingName !== null
					? <input key={id} className="pg-filename" style={nameBox.current} spellCheck={false} autoFocus aria-label={t("pgRenameFile")} value={editingName}
						onFocus={event => {
							const input = event.currentTarget;
							const dot = input.value.lastIndexOf(".");
							input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
						}}
						onChange={event => setEditingName(event.target.value)}
						onBlur={event => { if (event.currentTarget.validity.valid && editingName.trim()) rename(editingName.trim()); setEditingName(null); }}
						onKeyDown={event => {
							if (event.nativeEvent.isComposing) return;
							if (event.key !== "Enter" && event.key !== "Escape") return;
							event.preventDefault();
							if (event.key === "Enter") {
								if (!event.currentTarget.reportValidity()) return;
								rename(editingName.trim());
							}
							setEditingName(null);
							requestAnimationFrame(() => nameButton.current?.focus({ preventScroll: true }));
						}}
						onInput={event => {
							const input = event.currentTarget;
							const name = input.value.trim();
							const duplicate = [...files, "main.py"].some(other => other !== file && label(other) === name);
							input.setCustomValidity(!name || /[/\\]/.test(name) || duplicate ? t("pgInvalidName") : "");
						}} />
					: <button className="btn" key={id} ref={id === file ? nameButton : undefined} aria-pressed={id === file} disabled={running}
						title={id === file ? t("pgRenameFile") : label(id)}
						onClick={async event => {
							if (id === file) {
								const { width, height } = event.currentTarget.getBoundingClientRect();
								nameBox.current = { width, height };
								setEditingName(label(id));
							} else if (await save()) setFile(id);
						}}>
						<FiFileText />{label(id)}
					</button>)}
				<button className="btn" title={t("close") + " " + label(file)} disabled={running} onClick={async () => { if (await save()) close(); }}><FiX /></button>
				<button className="btn" title={t("pgNewFile")} disabled={running} onClick={async () => { if (await save()) add(); }}><FiPlus /></button></div>
			{running ? <button type="button" className="btn scratch-run-button" aria-label={t("playgroundStop")} title={t("playgroundStop")} onClick={stop}><FiSquare aria-hidden="true" /></button> : <>

				<button type="button" className="btn scratch-run-button is-run" aria-label={t("playgroundRun")} disabled={!!reason || !!(method && caseBatchError) || !doc?.content.trim()} title={reason || caseBatchError || `${t("playgroundRun")} (⌘/Ctrl+Enter)`} onClick={() => void start()}><FiPlay aria-hidden="true" /></button>
			</>}
				</div>
				{((language.state === "error" && missingPythonEditorTools(language.reason ?? "")) || missingPythonEditorTools(formatError)) && <PlaygroundToolsInstall available={!!status?.python.available} />}
				{formatError && <div className="playground-notice scratch-format-error" role="alert">
					<p>{formatFailure?.operation === "indent" ? t("pgAutoIndentFailed") : formatErrorLine ? t("pgFormatSyntaxError").replace("{line}", formatErrorLine) : t("pgFormatFailed")}</p>
					<details className="notice-technical"><summary>{t("noticeTechnicalDetails")}</summary><pre>{formatError}</pre></details>
				</div>}
				{doc && !doc.content.trim() && <button type="button" className="btn scratch-example" onClick={() => setDoc({ ...doc, content: EXAMPLE })}>{t("pgExample")}</button>}
				<Suspense fallback={<div className="scratch-editor-cm loading" aria-busy="true" />}>
					<ScratchEditor onCursorChange={setCursor} ref={editor} value={doc?.content ?? ""} onChange={content => setDoc(current => current ? { ...current, content } : current)} onRun={() => void start()} onFormat={() => void formatCode()} onSave={() => void formatCode(true)} onLanguageStatus={languageStatus} placeholder={t("playgroundScratchPlaceholder")} />
				</Suspense>
				<div className="scratch-code-foot"><span>Python</span><span>{t("pgSendShortcut")}</span><span>Ctrl+S {t("save")}</span><span>Ln {cursor.line}, Col {cursor.column}</span><span>Spaces: 4</span><span>UTF-8</span><span>LF</span><span className={`scratch-language-status ${language.state}`} title={language.reason} role="status">{t(language.state === "ready" ? "pgLanguageReady" : language.state === "error" ? "pgLanguageError" : "pgLanguageLoading")}</span></div>
			</section>
			{doc && <aside hidden={collapsed} id="scratch-results" className="scratch-test-pane" aria-label={t("pgResults")}>
				<div className="scratch-pane-head lc-panel-head"><div role="tablist" aria-label={t("pgResults")} onKeyDown={event => {
					if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
					event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (resultTab + (event.key === "ArrowLeft" ? 2 : 1)) % 3;
					setResultTab(next); if (next === 2) setChatOpened(true); document.getElementById(["pg-cases-tab", "pg-result-tab", "pg-chat-tab"][next])?.focus();
				}}>{[0, 1, 2].map(result => <button key={String(result)} id={["pg-cases-tab", "pg-result-tab", "pg-chat-tab"][result]} role="tab" aria-selected={resultTab === result} aria-controls="pg-test-panel" tabIndex={resultTab === result ? 0 : -1} onClick={() => { setResultTab(result); if (result === 2) setChatOpened(true); }}>{result === 2 ? <FiMessageSquare aria-hidden="true" /> : result === 1 ? <FiTerminal aria-hidden="true" /> : <FiSliders aria-hidden="true" />}{t(result === 2 ? "pgAssistantTab" : result === 1 ? "pgTestResult" : "pgTestCases")}</button>)}</div></div>
				<div id="pg-test-panel" className={resultTab === 2 ? "is-chat" : undefined} role="tabpanel" aria-labelledby={["pg-cases-tab", "pg-result-tab", "pg-chat-tab"][resultTab]}>
				<div hidden={resultTab !== 0}><PlaygroundMethodCases methods={discovered.methods} selected={tests.selectedMethod} cases={cases} onSelect={selectedMethod => updateTests({ selectedMethod })} onChange={next => updateTests({ casesByMethod: { ...tests.casesByMethod, [tests.selectedMethod]: next } })} /></div>
				{chatOpened && <div hidden={resultTab !== 2}><PlaygroundChat apply={(base, code) => editor.current?.applyProposal(base, code) ?? false} context={{ code: doc.content, parameters: JSON.stringify({ method: method?.id, parameters: cases[0]?.args }), output: output.text, partial: running, stale: !!lastRun && snapshot !== lastRun.snapshot, truncated: output.truncated || programRun.truncated || casesRun.truncated, runVersion: lastRun?.version }} /></div>}
				<div className="scratch-run-region" hidden={resultTab !== 1}>
					{lastRun ? <ScratchOutput clear={() => { recentRuns.delete(file); setLastRun(undefined); }} executing={executing} program={programRun} cases={lastRun.ranCases ? casesRun : undefined} stale={snapshot !== lastRun.snapshot} /> : <p className="lc-result-empty">{t("pgRunToSeeResults")}</p>}
				</div>
				</div>
			</aside>}
		</div>
	</div>;
}
