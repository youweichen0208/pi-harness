import { FiPlus, FiPlay, FiTrash2 } from "react-icons/fi";
import { useT } from "../i18n";
import type { PlaygroundCase, PlaygroundMethod, PlaygroundValue } from "../types";
import { isReferenceType, validateCases } from "../../../server/playground-methods";
import { randomUuid } from "../uuid";

export function methodErrorText(message: string, t: ReturnType<typeof useT>): string {
	const casePrefix = /^Case (\d+): (.*)$/.exec(message);
	if (casePrefix) return `${t("pgCase")} ${casePrefix[1]}: ${methodErrorText(casePrefix[2], t)}`;
	const exact = {
		"Only primitive types, boxed types, String and arrays are supported.": "pgTypesOnly",
		"Generic methods and classes are not supported.": "pgNoGenerics",
		"Instance methods require a concrete class with a default or public no-argument constructor.": "pgConstructor",
		"The method must have an implementation.": "pgImplementation",
		"Provide between 1 and 50 test cases": "pgCaseCount",
		"Parameter count does not match the method": "pgParamCount",
		"Large integers in arrays must be quoted decimal strings": "pgLargeInteger",
		"char requires exactly one UTF-16 character": "pgChar",
		"boolean requires true or false": "pgBoolean",
		"Unsupported type: void": "pgVoidExpected",
	} as const;
	if (Object.hasOwn(exact, message)) return t(exact[message as keyof typeof exact]);
	for (const [pattern, key] of [
		[/^(.*?) cannot be null$/, "pgNotNull"], [/^(.*?) is out of range$/, "pgRange"],
		[/^(.*?) requires an integer$/, "pgInteger"], [/^(.*?) requires a finite number$/, "pgNumber"],
		[/^(.*?) requires text$/, "pgText"], [/^(.*?) requires a JSON array$/, "pgArray"],
		[/^Invalid (.*?) value$/, "pgInvalidValue"],
	] as const) {
		const match = pattern.exec(message);
		if (match) return t(key, { type: match[1] });
	}
	if (/JSON|Unexpected|Unterminated|Expected|unterminated/i.test(message)) return t("pgJson");
	return message;
}

function ValueInput({ type, value, onChange, label }: { type: string; value: PlaygroundValue; onChange: (value: PlaygroundValue) => void; label: string }) {
	const t = useT();
	return <div className="method-value">
		<label><span>{label} <code>{type}</code></span>
			<input aria-label={label} value={value.text} disabled={value.isNull} onChange={event => onChange({ ...value, text: event.target.value })} spellCheck={false} placeholder={type.endsWith("[]") ? "[1, 2]" : type === "boolean" || type === "Boolean" ? "true / false" : ""} />
		</label>
		{isReferenceType(type) && <label className="method-check"><input type="checkbox" checked={!!value.isNull} onChange={event => onChange({ ...value, isNull: event.target.checked })} />{t("pgNull")}</label>}
	</div>;
}
export function caseError(method: PlaygroundMethod | undefined, cases: PlaygroundCase[]): string {
	if (!method) return "";
	try { validateCases(method, cases); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
}
export function PlaygroundMethodCases({ methods, selected, cases, onSelect, onChange, onRun, disabled }: {
	methods: PlaygroundMethod[]; selected: string; cases: PlaygroundCase[];
	onSelect: (id: string) => void; onChange: (cases: PlaygroundCase[]) => void;
	onRun: (cases: PlaygroundCase[]) => void; disabled: boolean;
}) {
	const t = useT();
	const method = methods.find(m => m.id === selected);
	const remove = (index: number) => onChange(cases.filter((_, i) => i !== index));
	const update = (index: number, test: PlaygroundCase) => onChange(cases.map((item, i) => i === index ? test : item));
	return <section className="method-tests" aria-label={t("pgMethods")}>
		<div className="method-toolbar">
			<label>{t("pgMethod")}<select value={selected} onChange={event => onSelect(event.target.value)}>
				{!method && <option value={selected}>{selected || t("pgMethod")}</option>}
				{methods.map(m => <option key={m.id} value={m.id}>{m.id} → {m.returnType}</option>)}
			</select></label>
			<button type="button" className="btn" disabled={!method || !!method.unsupported || cases.length >= 50} onClick={() => { if (!method) return; const id = randomUuid(); onChange([...cases, { id, args: method.parameters.map(() => ({ text: "" })) }]); }}><FiPlus aria-hidden="true" />{t("pgAddCase")}</button>
		</div>
		{!methods.length && !selected && <p className="playground-hint">{t("pgNoMethods")}</p>}
		{selected && !method && <p className="playground-notice">{t("pgMissingMethod")}</p>}
		{method?.unsupported && <p className="playground-notice">{methodErrorText(method.unsupported, t)}</p>}
		{method && !cases.length && <p className="playground-hint">{t("pgEmptyCases")}</p>}
		{cases.map((test, index) => {
			const error = caseError(method, [test]);
			return <fieldset className="method-case" key={test.id}>
				<legend>{t("pgCase")} {index + 1}</legend>
				{method?.parameters.some(parameter => /String|\[\]/.test(parameter.type)) && <p className="playground-hint">{t("pgInputHint")}</p>}
				<div className="method-parameters">
					{test.args.map((value, i) => <ValueInput key={i} type={method?.parameters[i]?.type ?? "String"} label={method?.parameters[i]?.name || `arg${i + 1}`} value={value} onChange={next => update(index, { ...test, args: test.args.map((v, j) => j === i ? next : v) })} />)}
					{method?.returnType !== "void" && <div className="method-expected">
						<label className="method-check"><input type="checkbox" checked={!!test.expected} onChange={event => update(index, { ...test, expected: event.target.checked ? { text: "" } : undefined })} />{t("pgExpected")}</label>
						{test.expected && <ValueInput type={method?.returnType ?? "String"} label={t("pgExpectedValue")} value={test.expected} onChange={expected => update(index, { ...test, expected })} />}
					</div>}
				</div>
				<div className="method-case-actions">
					{error && <span className="method-validation" role="status">{methodErrorText(error, t)}</span>}
					<button type="button" className="btn" disabled={disabled || !method || !!error} onClick={() => onRun([test])}><FiPlay aria-hidden="true" />{t("playgroundRun")}</button>
					<button type="button" className="btn" onClick={() => remove(index)}><FiTrash2 aria-hidden="true" />{t("pgRemoveCase")}</button>
				</div>
			</fieldset>;
		})}
	</section>;
}
