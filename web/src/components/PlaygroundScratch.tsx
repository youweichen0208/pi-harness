import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiPlay, FiSquare } from "react-icons/fi";
import { useT } from "../i18n";
import { usePlaygroundHost } from "../playground-context";
import { runKey, startRun, stopRun, usePlaygroundRun } from "../playground-run-store";
import { withToken } from "../auth-token";
import type { PlaygroundScratch as ScratchDoc, PlaygroundTestConfig, PlaygroundCase } from "../types";
import { discoverJavaMethods } from "../../../server/playground-methods";
import { PlaygroundResult } from "./PlaygroundRun";
import { PlaygroundMethodCases, caseError, methodErrorText } from "./PlaygroundMethodCases";

const ScratchEditor = lazy(() => import("./scratch-editor").then(m => ({ default: m.ScratchEditor })));
const TEMPLATE = `public class Main {
	public static void main(String[] args) {
		System.out.println("Hello, Playground");
	}
}`;
const EXAMPLE = `public int add(int a, int b) {
	return a + b;
}`;
const EMPTY_TESTS: PlaygroundTestConfig = { mode: "program", selectedMethod: "", casesByMethod: {} };
type Draft = { content: string; tests: PlaygroundTestConfig };
// Serialize writes across remounts as well as keystrokes. Re-entry waits for a
// pending flush before reading the server, so an old response cannot win.
let saveQueue: Promise<void> = Promise.resolve();
let lastScratchRun: { key: string; snapshot: string; methodId?: string } | null = null;
function persistDraft(doc: Draft): Promise<void> {
	const operation = saveQueue.then(async () => {
		const response = await fetch(withToken("/api/playground/scratch"), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
		if (!response.ok) throw new Error(String(response.status));
	});
	saveQueue = operation.catch(() => {});
	return operation;
}

export function PlaygroundScratch() {
	const t = useT();
	const { status } = usePlaygroundHost();
	const [doc, setDoc] = useState<Draft | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);
	const [lastRun, setLastRun] = useState(lastScratchRun);
	const run = usePlaygroundRun(lastRun?.key ?? "");
	const running = run.phase === "running";
	const latest = useRef(doc);
	latest.current = doc;
	const persisted = useRef("");
	const queued = useRef("");
	const snapshot = doc ? JSON.stringify(doc) : "";
	const tests = doc?.tests ?? EMPTY_TESTS;
	const methodMode = tests.mode === "methods";
	const discovered = useMemo(() => methodMode ? discoverJavaMethods(doc?.content ?? "") : { methods: [] }, [methodMode, doc?.content]);
	const method = discovered.methods.find(m => m.id === tests.selectedMethod);
	const cases = Object.hasOwn(tests.casesByMethod, tests.selectedMethod) ? tests.casesByMethod[tests.selectedMethod] : [];

	const save = useCallback(async (draft: Draft) => {
		const serialized = JSON.stringify(draft);
		if (serialized === queued.current) return;
		queued.current = serialized;
		try {
			await persistDraft(draft);
			persisted.current = serialized;
			if (serialized === JSON.stringify(latest.current) && queued.current === serialized) {
				setSaveFailed(false);
			}
		} catch {
			if (queued.current === serialized) queued.current = persisted.current;
			setSaveFailed(true);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				await saveQueue;
				const response = await fetch(withToken("/api/playground/scratch"));
				if (!response.ok) throw new Error(String(response.status));
				const stored = await response.json() as ScratchDoc;
				if (cancelled) return;
				const draft = { content: stored.updatedAt === 0 && !stored.content ? TEMPLATE : stored.content, tests: stored.tests ?? EMPTY_TESTS };
				persisted.current = stored.updatedAt ? JSON.stringify(draft) : "";
				queued.current = persisted.current;
				setDoc(draft);
			} catch { if (!cancelled) setLoadFailed(true); }
		})();
		return () => { cancelled = true; };
	}, []);
	useEffect(() => {
		if (!doc) return;
		if (snapshot === queued.current) return;
		const timer = window.setTimeout(() => { void save(doc); }, 600);
		return () => window.clearTimeout(timer);
	}, [doc, snapshot, save]);
	useEffect(() => () => {
		if (latest.current && JSON.stringify(latest.current) !== queued.current) void save(latest.current);
	}, [save]);
	useEffect(() => {
		if (methodMode && !tests.selectedMethod && discovered.methods.length) setDoc(current => current ? { ...current, tests: { ...current.tests, selectedMethod: discovered.methods[0].id } } : current);
	}, [methodMode, tests.selectedMethod, discovered]);

	const reason = !status ? t("playgroundChecking") : status.locked ? t("playgroundLocked") : !status.enabled ? t("playgroundDisabled") : !status.jdk.available ? [t("playgroundNoJdk"), status.jdk.reason].filter(Boolean).join(" — ") : "";
	const inputError = methodMode ? !method ? t("pgNoMethods") : caseError(method, cases) : "";
	const start = useCallback((selectedCases?: PlaygroundCase[]) => {
		if (!doc || reason || running || !doc.content.trim()) return;
		const requested = methodMode ? { methodId: tests.selectedMethod, cases: selectedCases ?? cases } : undefined;
		if (requested && (!method || caseError(method, requested.cases))) return;
		const key = runKey("scratch", JSON.stringify({ code: doc.content, tests: requested }));
		lastScratchRun = { key, snapshot: JSON.stringify(doc), methodId: requested?.methodId };
		setLastRun(lastScratchRun);
		void startRun(key, doc.content, requested);
	}, [doc, reason, running, methodMode, tests.selectedMethod, cases, method]);
	const updateTests = (patch: Partial<PlaygroundTestConfig>) => setDoc(current => current ? { ...current, tests: { ...current.tests, ...patch } } : current);

	return <div className={`scratch-page${methodMode ? " method-mode" : ""}`}>
		<header className="scratch-head">
			<h2>Playground</h2>
			<select className="scratch-mode" aria-label={t("pgMode")} disabled={!doc} value={tests.mode} onChange={event => updateTests({ mode: event.target.value as PlaygroundTestConfig["mode"] })}>
				<option value="program">{t("pgProgram")}</option><option value="methods">{t("pgMethods")}</option>
			</select>
			{running ? <button type="button" className="btn" onClick={() => lastRun && stopRun(lastRun.key)}><FiSquare aria-hidden="true" />{t("playgroundStop")}</button> : <>
				<button type="button" className="btn primary" disabled={!!reason || !!inputError || !doc?.content.trim()} title={reason || methodErrorText(inputError, t) || "⌘/Ctrl+Enter"} onClick={() => start()}><FiPlay aria-hidden="true" />{t(methodMode ? "pgRunAll" : "playgroundRun")}</button>
			</>}
			{saveFailed && <span className="scratch-save-error" role="alert">{t("fileSaveFailed")}</span>}
		</header>
		{loadFailed && <p className="playground-notice" role="alert">{t("pgLoadFailed")}</p>}
		{methodMode && doc && (!doc.content.trim() || doc.content === TEMPLATE) && <button type="button" className="btn scratch-example" onClick={() => setDoc({ ...doc, content: EXAMPLE })}>{t("pgExample")}</button>}
		<Suspense fallback={<div className="scratch-editor-cm loading" aria-busy="true" />}>
			<ScratchEditor value={doc?.content ?? ""} onChange={content => setDoc(current => current ? { ...current, content } : current)} onRun={() => start()} placeholder={t("playgroundScratchPlaceholder")} />
		</Suspense>
		{methodMode && doc && <PlaygroundMethodCases methods={discovered.methods} selected={tests.selectedMethod} cases={cases} onSelect={selectedMethod => updateTests({ selectedMethod })} onChange={next => updateTests({ casesByMethod: { ...tests.casesByMethod, [tests.selectedMethod]: next } })} onRun={start} disabled={!!reason || running} />}
		{lastRun && <PlaygroundResult runKey={lastRun.key} stale={snapshot !== lastRun.snapshot} />}
	</div>;
}
