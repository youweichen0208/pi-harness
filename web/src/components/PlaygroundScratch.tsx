import { CopyButton } from "./copy-button";
import { PlaygroundChat } from "./PlaygroundChat";
import { boundedPlaygroundOutput } from "../playground-chat-context";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiPlay, FiSquare, FiCode, FiHash, FiChevronsRight, FiChevronsLeft, FiAlignLeft, FiSliders, FiTerminal } from "react-icons/fi";
import { missingPythonEditorTools, pythonFormatErrorLine } from "../playground-format-error";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { usePlaygroundHost } from "../playground-context";
import { runKey, startRun, stopRun, usePlaygroundRun } from "../playground-run-store";
import { usePlaygroundScratch } from "../use-playground-scratch";
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
let lastScratchRun: { version: string; programKey: string; casesKey: string; snapshot: string; methodId?: string; ranCases: boolean } | null = null;

export function PlaygroundScratch() {
	const t = useT();
	const editor = useRef<ScratchEditorHandle>(null);
	const [cursor, setCursor] = useState({ line: 1, column: 1 });
	const [resultsOpen, setResultsOpen] = useState(true);
	const [resultTab, setResultTab] = useState<number>(0);
	const [chatOpened, setChatOpened] = useState(false);
	const [executing, setExecuting] = useState(false);
	const cancelled = useRef(false);
	const resultsToggle = useRef<HTMLButtonElement>(null);
	const [language, setLanguage] = useState<{ state: "loading" | "ready" | "error"; reason?: string }>({ state: "loading" });
	const languageStatus = useCallback((state: "loading" | "ready" | "error", reason?: string) => setLanguage({ state, reason }), []);
	const [formatting, setFormatting] = useState(false);
	const [formatFailure, setFormatFailure] = useState<{ source: string; message: string; operation: "format" | "indent" } | null>(null);
	const formatController = useRef<AbortController | null>(null);
	useEffect(() => () => formatController.current?.abort(), []);
	const { status } = usePlaygroundHost();
	const { doc, edit: setDoc, save, reload, conflict, loadFailed, saveState, savedAt: savedTime } = usePlaygroundScratch();
	const formatError = formatFailure?.source === doc?.content ? formatFailure?.message ?? "" : "";
	const formatErrorLine = pythonFormatErrorLine(formatError);
	const savedAt = savedTime ? new Date(savedTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
	const [lastRun, setLastRun] = useState(lastScratchRun);
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
		lastScratchRun = { version: invocation, programKey, casesKey, snapshot: JSON.stringify(doc), methodId: method?.id, ranCases: !!requested };
		setResultsOpen(true);
		setResultTab(1);
		setLastRun(lastScratchRun);
		cancelled.current = false;
		setExecuting(true);
		try {
			await startRun(programKey, doc.content);
			if (requested && !cancelled.current) await startRun(casesKey, doc.content, { methodId: method!.id, cases: requested });
		} finally { setExecuting(false); }
	}, [doc, reason, running, cases, method, caseBatchError]);
	const stop = () => { cancelled.current = true; if (lastRun) { stopRun(lastRun.programKey); stopRun(lastRun.casesKey); } };
	const formatCode = async (saveAfter = false, operation: "format" | "indent" = "format") => {
		if (!doc) return;
		if (formatController.current) { if (saveAfter) await save(); return; }
		let source = doc.content;
		let stage = saveAfter ? "indent" as const : operation;
		const controller = new AbortController();
		formatController.current = controller;
		setFormatting(true); setFormatFailure(null);
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
				setFormatting(false);
				if (saveAfter) await save();
			}
		}
	};
	const updateTests = (patch: Partial<PlaygroundTestConfig>) => setDoc(current => current ? { ...current, tests: { ...current.tests, ...patch } } : current);

	return <div className="scratch-page method-mode">
		<header className="scratch-head">
			<h2>Playground <span className="scratch-language-badge">Python</span></h2>

			<span className={`scratch-save-status${saveState === "error" ? " error" : ""}`} role={saveState === "error" ? "alert" : undefined}>{saveState === "error" ? t("fileSaveFailed") : saveState === "pending" || saveState === "saving" ? t("playgroundSaving") : savedAt ? `${t("playgroundSaved")} · ${savedAt}` : doc ? t("playgroundSaved") : ""}</span>
			<button className="btn" onClick={() => { setChatOpened(true); setResultsOpen(true); setResultTab(2); requestAnimationFrame(() => document.getElementById("pg-chat-input")?.focus()); }}>{t("pgChatAsk")}</button>
			<button ref={resultsToggle} type="button" className="btn scratch-results-toggle" aria-label={t(resultsOpen ? "pgResultHide" : "pgResultShow")} title={t(resultsOpen ? "pgResultHide" : "pgResultShow")} aria-expanded={resultsOpen} aria-controls="scratch-results" onClick={() => setResultsOpen(open => !open)}>{resultsOpen ? <FiChevronsRight /> : <FiChevronsLeft />}</button>
			{running ? <button type="button" className="btn" onClick={stop}><FiSquare aria-hidden="true" />{t("playgroundStop")}</button> : <>

				<button type="button" className="btn primary" disabled={!!reason || !!(method && caseBatchError) || !doc?.content.trim()} title={reason || caseBatchError || "⌘/Ctrl+Enter"} onClick={() => void start()}><FiPlay aria-hidden="true" />{t("playgroundRun")}<kbd className="scratch-run-shortcut" aria-hidden="true">{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} ↵</kbd></button>
			</>}
		</header>
		{(reason || (method && caseBatchError)) && <p className="scratch-run-hint" role="status">{reason || t("pgParametersRequired")}</p>}
		{conflict && <div className="playground-notice" role="alert"><p>{t("pgScratchConflict")}</p><CopyButton text={JSON.stringify(doc, null, 2)} /><button className="btn" onClick={() => void reload()}>{t("pgScratchReload")}</button></div>}
		{loadFailed && <p className="playground-notice" role="alert">{t("pgLoadFailed")}</p>}
		<div className={`scratch-workspace${resultsOpen ? "" : " results-collapsed"}`}>
			<section className="scratch-code-pane" aria-label={t("pgSource")}>
				<div className="scratch-pane-head"><strong>{t("pgSource")}</strong><span className={`scratch-language-status ${language.state}`} title={language.reason} role="status">{t(language.state === "ready" ? "pgLanguageReady" : language.state === "error" ? "pgLanguageError" : "pgLanguageLoading")}</span><button type="button" className="btn" disabled={!doc} title={t("pgCommentHint")} onClick={() => editor.current?.toggleComment()} aria-label={t("pgComment")}><FiHash aria-hidden="true" /></button><button type="button" className="btn" disabled={!doc || formatting || !status?.python.available} title={t("pgAutoIndentHint")} aria-label={t("pgAutoIndent")} onClick={() => void formatCode(false, "indent")}><FiAlignLeft aria-hidden="true" /></button><button type="button" className="btn" disabled={!doc || formatting} title="Shift+Alt+F" onClick={() => void formatCode()} aria-label={t(formatting ? "pgFormatting" : "pgFormat")}><FiCode aria-hidden="true" /></button></div>
				{((language.state === "error" && missingPythonEditorTools(language.reason ?? "")) || missingPythonEditorTools(formatError)) && <PlaygroundToolsInstall available={!!status?.python.available} />}
				{formatError && <div className="playground-notice scratch-format-error" role="alert">
					<p>{formatFailure?.operation === "indent" ? t("pgAutoIndentFailed") : formatErrorLine ? t("pgFormatSyntaxError").replace("{line}", formatErrorLine) : t("pgFormatFailed")}</p>
					<details className="notice-technical"><summary>{t("noticeTechnicalDetails")}</summary><pre>{formatError}</pre></details>
				</div>}
				{doc && !doc.content.trim() && <button type="button" className="btn scratch-example" onClick={() => setDoc({ ...doc, content: EXAMPLE })}>{t("pgExample")}</button>}
				<Suspense fallback={<div className="scratch-editor-cm loading" aria-busy="true" />}>
					<ScratchEditor onCursorChange={setCursor} ref={editor} value={doc?.content ?? ""} onChange={content => setDoc(current => current ? { ...current, content } : current)} onRun={() => void start()} onFormat={() => void formatCode()} onSave={() => void formatCode(true)} onLanguageStatus={languageStatus} placeholder={t("playgroundScratchPlaceholder")} />
				</Suspense>
				<div className="scratch-code-foot"><span>Ln {cursor.line}, Col {cursor.column}</span><span>{status?.python.version ? `Python ${status.python.version}` : "Python"}</span><span>UTF-8</span><span>LF</span></div>
			</section>
			{doc && <aside id="scratch-results" hidden={!resultsOpen} className="scratch-test-pane" aria-label={t("pgResults")}>
				<div className="scratch-pane-head lc-panel-head"><div role="tablist" aria-label={t("pgResults")} onKeyDown={event => {
					if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
					event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (resultTab + (event.key === "ArrowLeft" ? 2 : 1)) % 3;
					setResultTab(next); if (next === 2) setChatOpened(true); document.getElementById(["pg-cases-tab", "pg-result-tab", "pg-chat-tab"][next])?.focus();
				}}>{[0, 1, 2].map(result => <button key={String(result)} id={["pg-cases-tab", "pg-result-tab", "pg-chat-tab"][result]} role="tab" aria-selected={resultTab === result} aria-controls="pg-test-panel" tabIndex={resultTab === result ? 0 : -1} onClick={() => { setResultTab(result); if (result === 2) setChatOpened(true); }}>{result ? <FiTerminal aria-hidden="true" /> : <FiSliders aria-hidden="true" />}{t(result === 2 ? "pgChatAsk" : result === 1 ? "pgTestResult" : "pgTestCases")}</button>)}</div><button type="button" className="btn" aria-label={t("pgResultHide")} onClick={() => { setResultsOpen(false); resultsToggle.current?.focus(); }}><FiChevronsRight aria-hidden="true" /></button></div>
				<div id="pg-test-panel" className={resultTab === 2 ? "is-chat" : undefined} role="tabpanel" aria-labelledby={["pg-cases-tab", "pg-result-tab", "pg-chat-tab"][resultTab]}>
				<div hidden={resultTab !== 0}><PlaygroundMethodCases key={tests.selectedMethod} methods={discovered.methods} selected={tests.selectedMethod} cases={cases} onSelect={selectedMethod => updateTests({ selectedMethod })} onChange={next => updateTests({ casesByMethod: { ...tests.casesByMethod, [tests.selectedMethod]: next } })} /></div>
				{chatOpened && <div hidden={resultTab !== 2}><PlaygroundChat apply={(base, code) => editor.current?.applyProposal(base, code) ?? false} context={{ code: doc.content, parameters: JSON.stringify({ method: method?.id, parameters: cases[0]?.args }), output: output.text, partial: running, stale: !!lastRun && snapshot !== lastRun.snapshot, truncated: output.truncated || programRun.truncated || casesRun.truncated, runVersion: lastRun?.version }} /></div>}
				<div className="scratch-run-region" hidden={resultTab !== 1}>
					{lastRun ? <ScratchOutput executing={executing} program={programRun} cases={lastRun.ranCases ? casesRun : undefined} stale={snapshot !== lastRun.snapshot} /> : <p className="lc-result-empty">{t("pgRunToSeeResults")}</p>}
				</div>
				</div>
			</aside>}
		</div>
	</div>;
}
