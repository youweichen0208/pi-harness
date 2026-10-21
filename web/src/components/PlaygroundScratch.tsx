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
const LEGACY_TEMPLATE = `public class Main {
	public static void main(String[] args) {
		System.out.println("Hello, Playground");
	}
}`;
const EXAMPLE = `public int add(int a, int b) {
	return a + b;
}`;
const EMPTY_TESTS: PlaygroundTestConfig = { mode: "methods", selectedMethod: "", casesByMethod: {} };
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
	const [saveState, setSaveState] = useState<"pending" | "saving" | "saved" | "error">("saved");
	const [savedAt, setSavedAt] = useState("");
	const [lastRun, setLastRun] = useState(lastScratchRun);
	const run = usePlaygroundRun(lastRun?.key ?? "");
	const running = run.phase === "running";
	const latest = useRef(doc);
	latest.current = doc;
	const persisted = useRef("");
	const queued = useRef("");
	const snapshot = doc ? JSON.stringify(doc) : "";
	const tests = doc?.tests ?? EMPTY_TESTS;
	const discovered = useMemo(() => discoverJavaMethods(doc?.content ?? ""), [doc?.content]);
	const method = discovered.methods.find(m => m.id === tests.selectedMethod);
	const cases = Object.hasOwn(tests.casesByMethod, tests.selectedMethod) ? tests.casesByMethod[tests.selectedMethod] : [];

	const save = useCallback(async (draft: Draft) => {
		const serialized = JSON.stringify(draft);
		if (serialized === queued.current) return;
		queued.current = serialized;
		setSaveState("saving");
		try {
			await persistDraft(draft);
			persisted.current = serialized;
			if (serialized === JSON.stringify(latest.current) && queued.current === serialized) {
				setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
				setSaveState("saved");
			}
		} catch {
			if (queued.current === serialized) queued.current = persisted.current;
			setSaveState("error");
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
				const draft: Draft = { content: stored.updatedAt === 0 && !stored.content ? EXAMPLE : stored.content, tests: { ...(stored.tests ?? EMPTY_TESTS), mode: "methods" } };
				persisted.current = stored.updatedAt ? JSON.stringify({ content: stored.content, tests: stored.tests }) : "";
				queued.current = persisted.current;
				setDoc(draft);
			} catch { if (!cancelled) setLoadFailed(true); }
		})();
		return () => { cancelled = true; };
	}, []);
	useEffect(() => {
		if (!doc) return;
		if (snapshot === queued.current) {
			if (snapshot === persisted.current) setSaveState("saved");
			return;
		}
		setSaveState("pending");
		const timer = window.setTimeout(() => { void save(doc); }, 600);
		return () => window.clearTimeout(timer);
	}, [doc, snapshot, save]);
	useEffect(() => () => {
		if (latest.current && JSON.stringify(latest.current) !== queued.current) void save(latest.current);
	}, [save]);
	useEffect(() => {
		if (!tests.selectedMethod && discovered.methods.length) setDoc(current => current ? { ...current, tests: { ...current.tests, selectedMethod: discovered.methods[0].id } } : current);
	}, [tests.selectedMethod, discovered]);

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
				<div className="scratch-pane-head"><strong>{t("pgSource")}</strong><span>Java</span></div>
				{doc && (!doc.content.trim() || doc.content === LEGACY_TEMPLATE) && <button type="button" className="btn scratch-example" onClick={() => setDoc({ ...doc, content: EXAMPLE })}>{t("pgExample")}</button>}
				<Suspense fallback={<div className="scratch-editor-cm loading" aria-busy="true" />}>
					<ScratchEditor value={doc?.content ?? ""} onChange={content => setDoc(current => current ? { ...current, content } : current)} onRun={() => start()} placeholder={t("playgroundScratchPlaceholder")} />
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
