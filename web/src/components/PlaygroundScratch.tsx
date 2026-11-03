import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiPlay, FiSquare, FiCode, FiHash, FiChevronsRight, FiChevronsLeft, FiTerminal, FiAlignLeft } from "react-icons/fi";
import { missingPythonEditorTools, pythonFormatErrorLine } from "../playground-format-error";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { usePlaygroundHost } from "../playground-context";
import { runKey, startRun, stopRun, usePlaygroundRun } from "../playground-run-store";
import { usePlaygroundScratch } from "../use-playground-scratch";
import { SCRATCH_EXAMPLE as EXAMPLE, EMPTY_SCRATCH_TESTS as EMPTY_TESTS } from "../playground-scratch-store";
import type { PlaygroundTestConfig, PlaygroundCase, PlaygroundFormatResult } from "../types";
import { discoverPythonMethods } from "../../../server/playground-methods";
import { PlaygroundToolsInstall } from "./PlaygroundToolsInstall";
import { PlaygroundResult } from "./PlaygroundRun";
import { PlaygroundMethodCases, caseError, methodErrorText } from "./PlaygroundMethodCases";

import type { ScratchEditorHandle } from "./scratch-editor";

const ScratchEditor = lazy(() => import("./scratch-editor").then(m => ({ default: m.ScratchEditor })));
let lastScratchRun: { key: string; snapshot: string; methodId?: string; pythonVersion?: string } | null = null;

export function PlaygroundScratch() {
	const t = useT();
	const editor = useRef<ScratchEditorHandle>(null);
	const [cursor, setCursor] = useState({ line: 1, column: 1 });
	const [resultsOpen, setResultsOpen] = useState(true);
	const resultsToggle = useRef<HTMLButtonElement>(null);
	const [language, setLanguage] = useState<{ state: "loading" | "ready" | "error"; reason?: string }>({ state: "loading" });
	const languageStatus = useCallback((state: "loading" | "ready" | "error", reason?: string) => setLanguage({ state, reason }), []);
	const [formatting, setFormatting] = useState(false);
	const [formatFailure, setFormatFailure] = useState<{ source: string; message: string; operation: "format" | "indent" } | null>(null);
	const formatController = useRef<AbortController | null>(null);
	useEffect(() => () => formatController.current?.abort(), []);
	const { status } = usePlaygroundHost();
	const { doc, edit: setDoc, save, loadFailed, saveState, savedAt: savedTime } = usePlaygroundScratch();
	const formatError = formatFailure?.source === doc?.content ? formatFailure?.message ?? "" : "";
	const formatErrorLine = pythonFormatErrorLine(formatError);
	const savedAt = savedTime ? new Date(savedTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
	const [lastRun, setLastRun] = useState(lastScratchRun);
	const run = usePlaygroundRun(lastRun?.key ?? "");
	const running = run.phase === "running";
	const snapshot = doc ? JSON.stringify(doc) : "";
	const tests = doc?.tests ?? EMPTY_TESTS;
	const discovered = useMemo(() => discoverPythonMethods(doc?.content ?? ""), [doc?.content]);
	const method = discovered.methods.find(m => m.id === tests.selectedMethod);
	const cases = Object.hasOwn(tests.casesByMethod, tests.selectedMethod) ? tests.casesByMethod[tests.selectedMethod] : [];

	useEffect(() => {
		if (!tests.selectedMethod && discovered.methods.length) setDoc(current => ({ ...current, tests: { ...current.tests, selectedMethod: discovered.methods[0].id } }));
	}, [tests.selectedMethod, discovered, setDoc]);

	const reason = !status ? t("playgroundChecking") : status.locked ? t("playgroundLocked") : !status.enabled ? t("playgroundDisabled") : !status.python.available ? [t("playgroundNoPython"), status.python.reason].filter(Boolean).join(" — ") : "";
	const inputError = tests.mode === "program" ? "" : !method ? t("pgNoMethods") : caseError(method, cases);
	const start = useCallback((selectedCases?: PlaygroundCase[]) => {
		if (!doc || reason || running || !doc.content.trim()) return;
		const requested = tests.mode === "methods" || selectedCases ? { methodId: tests.selectedMethod, cases: (selectedCases ?? cases).map(({ id, args }) => ({ id, args })) } : undefined;
		if (requested && (!method || caseError(method, requested.cases))) return;
		const key = runKey("scratch", JSON.stringify({ code: doc.content, tests: requested }));
		lastScratchRun = { key, snapshot: JSON.stringify(doc), methodId: requested?.methodId, pythonVersion: status?.python.version };
		setResultsOpen(true);
		setLastRun(lastScratchRun);
		void startRun(key, doc.content, requested);
	}, [doc, reason, running, tests.selectedMethod, tests.mode, cases, method, status?.python.version]);
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
			<h2>Playground · Python</h2>
			<select aria-label={t("pgMode")} value={tests.mode} onChange={e => updateTests({ mode: e.target.value as "program" | "methods" })}><option value="program">{t("pgProgram")}</option><option value="methods">{t("pgMethods")}</option></select>

			<span className={`scratch-save-status${saveState === "error" ? " error" : ""}`} role={saveState === "error" ? "alert" : undefined}>{saveState === "error" ? t("fileSaveFailed") : saveState === "pending" || saveState === "saving" ? t("playgroundSaving") : savedAt ? `${t("playgroundSaved")} · ${savedAt}` : doc ? t("playgroundSaved") : ""}</span>
			<button ref={resultsToggle} type="button" className="btn scratch-results-toggle" aria-label={t(resultsOpen ? "pgResultHide" : "pgResultShow")} title={t(resultsOpen ? "pgResultHide" : "pgResultShow")} aria-expanded={resultsOpen} aria-controls="scratch-results" onClick={() => setResultsOpen(open => !open)}>{resultsOpen ? <FiChevronsRight /> : <FiChevronsLeft />}</button>
			{running ? <button type="button" className="btn" onClick={() => lastRun && stopRun(lastRun.key)}><FiSquare aria-hidden="true" />{t("playgroundStop")}</button> : <>
				<span className="scratch-run-keys" aria-hidden="true">⌘/Ctrl ↵</span>
				<button type="button" className="btn primary" disabled={!!reason || !!inputError || !doc?.content.trim()} title={reason || methodErrorText(inputError, t) || "⌘/Ctrl+Enter"} onClick={() => start()}><FiPlay aria-hidden="true" />{t(tests.mode === "program" ? "playgroundRun" : "pgRunAll")}</button>
			</>}
		</header>
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
					<ScratchEditor onCursorChange={setCursor} ref={editor} value={doc?.content ?? ""} onChange={content => setDoc(current => current ? { ...current, content } : current)} onRun={() => start()} onFormat={() => void formatCode()} onSave={() => void formatCode(true)} onLanguageStatus={languageStatus} placeholder={t("playgroundScratchPlaceholder")} />
				</Suspense>
				<div className="scratch-code-foot"><span>Ln {cursor.line}, Col {cursor.column}</span><span>{status?.python.version ? `Python ${status.python.version}` : "Python"}</span><span>UTF-8</span><span>LF</span></div>
			</section>
			{doc && <aside id="scratch-results" hidden={!resultsOpen} className="scratch-test-pane" aria-label={t(tests.mode === "methods" ? "pgMethods" : "pgOutput")}>
				<div className="scratch-pane-head"><strong>{t(tests.mode === "methods" ? "pgMethods" : "pgOutput")}</strong>{tests.mode === "methods" && <span>{t("pgCase")} {cases.length} / 50</span>}<button type="button" className="btn" aria-label={t("pgResultHide")} onClick={() => { setResultsOpen(false); resultsToggle.current?.focus(); }}><FiChevronsRight aria-hidden="true" /></button></div>
				{tests.mode === "methods" && <PlaygroundMethodCases key={tests.selectedMethod} methods={discovered.methods} selected={tests.selectedMethod} cases={cases} results={lastRun?.methodId === tests.selectedMethod ? run.cases : []} stale={snapshot !== lastRun?.snapshot} onSelect={selectedMethod => updateTests({ selectedMethod })} onChange={next => updateTests({ casesByMethod: { ...tests.casesByMethod, [tests.selectedMethod]: next } })} onRun={start} disabled={!!reason || running} />}
				{lastRun && <PlaygroundResult variant="scratch" pythonVersion={lastRun.pythonVersion} runKey={lastRun.key} stale={snapshot !== lastRun.snapshot} showCases={tests.mode === "program" || lastRun.methodId !== tests.selectedMethod} />}
				{!lastRun && <div className="scratch-empty-result"><span className="scratch-pending">{t("pgAwaitRun")}</span><div className="scratch-empty-copy"><FiTerminal aria-hidden="true" /><strong>{t("pgNeverRun")}</strong><p>{t("pgEmptyHint")}</p></div></div>}
				<p className="scratch-result-hint">{t(lastRun ? "pgRerunHint" : "pgPanelHint")}</p>
			</aside>}
		</div>
	</div>;
}
