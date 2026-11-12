import { useT } from "../i18n";
import type { PlaygroundCase, PlaygroundMethod, PlaygroundValue } from "../types";
import { defaultParameterValue, isJsonType, validateCases } from "../../../server/playground-methods";

export function methodErrorText(message: string, t: ReturnType<typeof useT>): string {
	const casePrefix = /^Case (\d+): (.*)$/.exec(message);
	if (casePrefix) return methodErrorText(casePrefix[2], t);
	const parameter = /^Invalid JSON parameter: (.+)$/.exec(message);
	if (parameter) return t("pgParameterInvalid").replace("{name}", parameter[1]);
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
	return <div className="method-value">
		<label><span>{label}</span>
			<textarea rows={Math.min(6, Math.max(1, value.text.split("\n").length))} aria-label={label} value={value.isNull ? "null" : value.text} onChange={event => onChange({ text: event.target.value })} onBlur={() => { if (!value.isNull && !value.text.trim() && isJsonType(type)) onChange(defaultParameterValue(type)); }} spellCheck={false} placeholder={isJsonType(type) ? defaultParameterValue(type).text : ""} />
		</label>
	</div>;
}

export function caseError(method: PlaygroundMethod | undefined, cases: PlaygroundCase[]): string {
	if (!method) return "";
	try { validateCases(method, cases.map(({ id, args }) => ({ id, args }))); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** One editable parameter set per function; legacy extra cases remain in storage. */
export function PlaygroundMethodCases({ methods, selected, cases, onSelect, onChange }: {
	methods: PlaygroundMethod[]; selected: string; cases: PlaygroundCase[];
	onSelect: (id: string) => void; onChange: (cases: PlaygroundCase[]) => void;
}) {
	const t = useT();
	const method = methods.find(m => m.id === selected);
	const active = cases[0];
	const error = active ? caseError(method, [active]) : "";
	return <section className="method-tests lc-method-tests" aria-label={t("pgMethods")}>
		<div className="method-toolbar"><label>{t("pgMethod")}<select value={selected} onChange={event => onSelect(event.target.value)}>
			{!method && <option value={selected}>{selected || t("pgMethod")}</option>}
			{methods.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
		</select></label></div>
		{!methods.length && !selected && <p className="playground-hint">{t("pgNoMethods")}</p>}
		{selected && !method && <p className="playground-notice">{t("pgMissingMethod")}</p>}
		{method?.unsupported && <p className="playground-notice">{methodErrorText(method.unsupported, t)}</p>}
		{active && <div className="lc-case-panel"><p className="scratch-parameter-hint">{t("pgParameterHint")}</p><div className="method-parameters">
			{active.args.map((value, i) => <ValueInput key={i} type={method?.parameters[i]?.type ?? "JSON"} label={method?.parameters[i]?.name || `arg${i + 1}`} value={value} onChange={next => onChange([{ ...active, args: active.args.map((v, j) => j === i ? next : v) }, ...cases.slice(1)])} />)}
		</div>{error && active.args.some(value => value.text.trim()) && <p className="method-validation" role="status">{methodErrorText(error, t)}</p>}</div>}
	</section>;
}
