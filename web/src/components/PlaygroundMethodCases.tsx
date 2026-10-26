import { useRef, useState } from "react";
import { FiChevronRight, FiPlus, FiPlay, FiTrash2 } from "react-icons/fi";
import type { PlaygroundRunState } from "../playground-run-store";
import { useT } from "../i18n";
import type { PlaygroundCase, PlaygroundMethod, PlaygroundValue } from "../types";
import { isJsonType, isReferenceType, validateCases, valuePlaceholder } from "../../../server/playground-methods";
import { randomUuid } from "../uuid";

export function methodErrorText(message: string, t: ReturnType<typeof useT>): string {
	const casePrefix = /^Case (\d+): (.*)$/.exec(message);
	if (casePrefix) return `${t("pgCase")} ${casePrefix[1]}: ${methodErrorText(casePrefix[2], t)}`;
	const exact = {
		"Provide between 1 and 50 test cases": "pgCaseCount",
		"Parameter count does not match the method": "pgParamCount",
		"Variadic and keyword-only parameters are not supported in function tests; use Run script.": "pgUnsupportedParameters",
	} as const;
	if (Object.hasOwn(exact, message)) return t(exact[message as keyof typeof exact]);

	if (/JSON|Unexpected|Unterminated|Expected|unterminated/i.test(message)) return t("pgJson");
	return message;
}

function ValueInput({ type, value, onChange, label }: { type: string; value: PlaygroundValue; onChange: (value: PlaygroundValue) => void; label: string }) {
	const t = useT();
	return <div className="method-value">
		<label><span>{label} <code>{type}</code></span>
			<input aria-label={label} value={value.text} disabled={value.isNull} onChange={event => onChange({ ...value, text: event.target.value })} spellCheck={false} placeholder={isJsonType(type) ? valuePlaceholder(type) : ""} />
		</label>
		{isReferenceType(type) && <label className="method-check"><input type="checkbox" checked={!!value.isNull} onChange={event => onChange({ ...value, isNull: event.target.checked })} />{t("pgNull")}</label>}
	</div>;
}
export function caseError(method: PlaygroundMethod | undefined, cases: PlaygroundCase[]): string {
	if (!method) return "";
	try { validateCases(method, cases); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
}
export function PlaygroundMethodCases({ methods, selected, cases, results, stale, onSelect, onChange, onRun, disabled }: {
	methods: PlaygroundMethod[]; selected: string; cases: PlaygroundCase[];
	results: PlaygroundRunState["cases"]; stale: boolean;
	onSelect: (id: string) => void; onChange: (cases: PlaygroundCase[]) => void;
	onRun: (cases: PlaygroundCase[]) => void; disabled: boolean;
}) {
	const t = useT();
	const addButton = useRef<HTMLButtonElement>(null);
	const [openId, setOpenId] = useState<string | null>(cases[0]?.id ?? null);
	const method = methods.find(m => m.id === selected);
	const remove = (index: number) => {
		onChange(cases.filter((_, i) => i !== index));
		const nextId = cases[index + 1]?.id ?? cases[index - 1]?.id ?? null;
		setOpenId(nextId);
		requestAnimationFrame(() => (nextId ? document.getElementById(`toggle-${nextId}`) : addButton.current)?.focus());
	};
	const update = (index: number, test: PlaygroundCase) => onChange(cases.map((item, i) => i === index ? test : item));
	return <section className="method-tests" aria-label={t("pgMethods")}>
		<div className="method-toolbar">
			<label>{t("pgMethod")}<select value={selected} onChange={event => onSelect(event.target.value)}>
				{!method && <option value={selected}>{selected || t("pgMethod")}</option>}
				{methods.map(m => <option key={m.id} value={m.id}>{m.id} → {m.returnType}</option>)}
			</select></label>
			<button ref={addButton} type="button" className="btn" disabled={!method || !!method.unsupported || cases.length >= 50} onClick={() => { if (!method) return; const id = randomUuid(); onChange([...cases, { id, args: method.parameters.map(() => ({ text: "" })) }]); setOpenId(id); }}><FiPlus aria-hidden="true" />{t("pgAddCase")}</button>
		</div>
		{!methods.length && !selected && <p className="playground-hint">{t("pgNoMethods")}</p>}
		{selected && !method && <p className="playground-notice">{t("pgMissingMethod")}</p>}
		{method?.unsupported && <p className="playground-notice">{methodErrorText(method.unsupported, t)}</p>}
		{method && !cases.length && <p className="playground-hint">{t("pgEmptyCases")}</p>}
		{cases.map((test, index) => {
			const error = caseError(method, [test]);
			const result = results.find(item => item.id === test.id);
			const statusLabel = result ? t(({ passed: "pgPassed", failed: "pgFailed", error: "pgError", unasserted: "pgUnasserted", skipped: "pgSkipped", pending: "pgPending", running: "pgRunning" } as const)[result.status]) : t("pgNotRun");
			const summary = `${method?.name ?? ""}(${test.args.map(value => value.isNull ? "null" : value.text || "…").join(", ")})`;
			const expanded = openId === test.id;
			return <article className="method-case" key={test.id} data-status={result?.status}>
				<button type="button" className="method-case-toggle" id={`toggle-${test.id}`} aria-expanded={expanded} aria-controls={`case-${test.id}`} onClick={() => setOpenId(expanded ? null : test.id)}>
					<FiChevronRight aria-hidden="true" /><span>{t("pgCase")} {index + 1}</span><code title={summary}>{summary}</code>
					<span className={`method-case-status ${stale && result ? "stale" : result?.status ?? ""}`}>{stale && result ? t("pgPreviousResult") : statusLabel}</span>
				</button>
				{expanded && <div className="method-case-body" id={`case-${test.id}`}>
				{method?.parameters.some(parameter => parameter.type === "str" || isJsonType(parameter.type)) && <p className="playground-hint">{t("pgInputHint")}</p>}
				<div className="method-parameters">
					{test.args.map((value, i) => <ValueInput key={i} type={method?.parameters[i]?.type ?? "JSON"} label={method?.parameters[i]?.name || `arg${i + 1}`} value={value} onChange={next => update(index, { ...test, args: test.args.map((v, j) => j === i ? next : v) })} />)}
					{<div className="method-expected">
						<label className="method-check"><input type="checkbox" checked={!!test.expected} onChange={event => update(index, { ...test, expected: event.target.checked ? { text: "" } : undefined })} />{t("pgExpected")}</label>
						{test.expected && <ValueInput type={method?.returnType ?? "JSON"} label={t("pgExpectedValue")} value={test.expected} onChange={expected => update(index, { ...test, expected })} />}
					</div>}
				</div>
				<div className="method-case-actions">
					{error && <span className="method-validation" role="status">{methodErrorText(error, t)}</span>}
					<button type="button" className="btn" disabled={disabled || !method || !!error} onClick={() => onRun([test])}><FiPlay aria-hidden="true" />{t("playgroundRun")}</button>
					<button type="button" className="btn" onClick={() => remove(index)}><FiTrash2 aria-hidden="true" />{t("pgRemoveCase")}</button>
				</div>
				{result && <div className={`method-result ${result.status}`} aria-live="polite">
					<strong>{stale ? `${t("pgPreviousResult")} · ` : ""}{statusLabel}</strong><span className="playground-meta">{result.durationMs}ms</span>
					{"actual" in result && result.actual !== undefined && <pre>{t("pgActual")}: {result.actual}</pre>}
					{"expected" in result && result.expected !== undefined && <pre>{t("pgExpectedValue")}: {result.expected}</pre>}
					{"error" in result && result.error && <pre>{result.error}</pre>}
				</div>}
				</div>}
			</article>;
		})}
	</section>;
}
