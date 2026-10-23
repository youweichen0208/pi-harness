import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiPlay, FiSquare } from "react-icons/fi";
import { useT } from "../i18n";
import { withToken } from "../auth-token";
import { usePlaygroundHost } from "../playground-context";
import { runKey, startRun, stopRun, usePlaygroundRun } from "../playground-run-store";
import { usePlaygroundScratch } from "../use-playground-scratch";
import { SCRATCH_EXAMPLE as EXAMPLE, EMPTY_SCRATCH_TESTS as EMPTY_TESTS } from "../playground-scratch-store";
import type { PlaygroundTestConfig, PlaygroundCase, PlaygroundFormatResult } from "../types";
import { discoverJavaMethods } from "../../../server/playground-methods";
import { PlaygroundResult } from "./PlaygroundRun";
import { PlaygroundMethodCases, caseError, methodErrorText } from "./PlaygroundMethodCases";

const ScratchEditor = lazy(() => import("./scratch-editor").then(m => ({ default: m.ScratchEditor })));
const LEGACY_TEMPLATE = `public class Main {
	public static void main(String[] args) {
		System.out.println("Hello, Playground");
	}
}`;
let lastScratchRun: { key: string; snapshot: string; methodId?: string } | null = null;

export function PlaygroundScratch() {
	const t = useT();
	const [language, setLanguage] = useState<{ state: "loading" | "ready" | "error"; reason?: string }>({ state: "loading" });
	const languageStatus = useCallback((state: "loading" | "ready" | "error", reason?: string) => setLanguage({ state, reason }), []);
	const [formatting, setFormatting] = useState(false);
	const [formatError, setFormatError] = useState(false);
	const formatController = useRef<AbortController | null>(null);
	useEffect(() => () => formatController.current?.abort(), []);
	const { status } = usePlaygroundHost();
	const { doc, edit: setDoc, save, loadFailed, saveState, savedAt: savedTime } = usePlaygroundScratch();
	const savedAt = savedTime ? new Date(savedTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
	const [lastRun, setLastRun] = useState(lastScratchRun);
	const run = usePlaygroundRun(lastRun?.key ?? "");
	const running = run.phase === "running";
	const snapshot = doc ? JSON.stringify(doc) : "";
	const tests = doc?.tests ?? EMPTY_TESTS;
	const discovered = useMemo(() => discoverJavaMethods(doc?.content ?? ""), [doc?.content]);
	const method = discovered.methods.find(m => m.id === tests.selectedMethod);
	const cases = Object.hasOwn(tests.casesByMethod, tests.selectedMethod) ? tests.casesByMethod[tests.selectedMethod] : [];

	useEffect(() => {
		if (!tests.selectedMethod && discovered.methods.length) setDoc(current => ({ ...current, tests: { ...current.tests, selectedMethod: discovered.methods[0].id } }));
	}, [tests.selectedMethod, discovered, setDoc]);

	const reason = !status ? t("playgroundChecking") : status.locked ? t("playgroundLocked") : !status.enabled ? t("playgroundDisabled") : !status.jdk.available ? [t("playgroundNoJdk"), status.jdk.reason].filter(Boolean).join(" — ") : "";
	const inputError = !method ? t("pgNoMethods") : caseError(method, cases);
	const start = useCallback((selectedCases?: PlaygroundCase[]) => {
		if (!doc || reason || running || !doc.content.trim()) return;
		const requested = { methodId: tests.selectedMethod, cases: selectedCases ?? cases };
		if (!method || caseError(method, requested.cases)) return;
		const key = runKey("scratch", JSON.stringify({ code: doc.content, tests: requested }));
		lastScratchRun = { key, snapshot: JSON.stringify(doc), methodId: requested.methodId };
		setLastRun(lastScratchRun);
		void startRun(key, doc.content, requested);
	}, [doc, reason, running, tests.selectedMethod, cases, method]);
	const formatCode = async (saveAfter = false) => {
		if (!doc || formatController.current) return;
		const source = doc.content;
		const controller = new AbortController();
		formatController.current = controller;
		setFormatting(true); setFormatError(false);
		try {
			const response = await fetch(withToken("/api/playground/format"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: source }), signal: controller.signal });
			if (!response.ok) throw new Error("format failed");
			const result = await response.json() as PlaygroundFormatResult;
			if (!controller.signal.aborted) setDoc(current => current.content === source ? { ...current, content: result.code } : current);
		} catch {
			if (!controller.signal.aborted) setFormatError(true);
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
			<h2>Playground</h2>

			<span className={`scratch-save-status${saveState === "error" ? " error" : ""}`} role={saveState === "error" ? "alert" : undefined}>{saveState === "error" ? t("fileSaveFailed") : saveState === "pending" || saveState === "saving" ? t("playgroundSaving") : savedAt ? `${t("playgroundSaved")} · ${savedAt}` : doc ? t("playgroundSaved") : ""}</span>
			{running ? <button type="button" className="btn" onClick={() => lastRun && stopRun(lastRun.key)}><FiSquare aria-hidden="true" />{t("playgroundStop")}</button> : <>
				<span className="scratch-run-keys" aria-hidden="true">⌘/Ctrl ↵</span>
				<button type="button" className="btn primary" disabled={!!reason || !!inputError || !doc?.content.trim()} title={reason || methodErrorText(inputError, t) || "⌘/Ctrl+Enter"} onClick={() => start()}><FiPlay aria-hidden="true" />{t("pgRunAll")}</button>
			</>}
		</header>
		{loadFailed && <p className="playground-notice" role="alert">{t("pgLoadFailed")}</p>}
		<div className="scratch-workspace">
			<section className="scratch-code-pane" aria-label={t("pgSource")}>
				<div className="scratch-pane-head"><strong>{t("pgSource")}</strong><span className="scratch-language-status" title={language.reason} role="status">{t(language.state === "ready" ? "pgLanguageReady" : language.state === "error" ? "pgLanguageError" : "pgLanguageLoading")}</span><button type="button" className="btn" disabled={!doc || formatting} title="Shift+Alt+F" onClick={() => void formatCode()}>{t(formatting ? "pgFormatting" : "pgFormat")}</button></div>
				{formatError && <p className="playground-notice" role="alert">{t("pgFormatFailed")}</p>}
				{doc && (!doc.content.trim() || doc.content === LEGACY_TEMPLATE) && <button type="button" className="btn scratch-example" onClick={() => setDoc({ ...doc, content: EXAMPLE })}>{t("pgExample")}</button>}
				<Suspense fallback={<div className="scratch-editor-cm loading" aria-busy="true" />}>
					<ScratchEditor value={doc?.content ?? ""} onChange={content => setDoc(current => current ? { ...current, content } : current)} onRun={() => start()} onFormat={() => void formatCode()} onSave={() => void formatCode(true)} onLanguageStatus={languageStatus} placeholder={t("playgroundScratchPlaceholder")} />
				</Suspense>
			</section>
			{doc && <aside className="scratch-test-pane" aria-label={t("pgMethods")}>
				<div className="scratch-pane-head"><strong>{t("pgMethods")}</strong><span>{t("pgCase")} {cases.length} / 50</span></div>
				<PlaygroundMethodCases key={tests.selectedMethod} methods={discovered.methods} selected={tests.selectedMethod} cases={cases} results={lastRun?.methodId === tests.selectedMethod ? run.cases : []} stale={snapshot !== lastRun?.snapshot} onSelect={selectedMethod => updateTests({ selectedMethod })} onChange={next => updateTests({ casesByMethod: { ...tests.casesByMethod, [tests.selectedMethod]: next } })} onRun={start} disabled={!!reason || running} />
				{lastRun && <PlaygroundResult runKey={lastRun.key} stale={snapshot !== lastRun.snapshot} showCases={lastRun.methodId !== tests.selectedMethod} />}
			</aside>}
		</div>
	</div>;
}
