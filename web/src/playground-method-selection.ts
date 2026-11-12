import { defaultParameterValue } from "../../server/playground-methods.js";
import type { PlaygroundMethod, PlaygroundTestConfig } from "../../server/protocol.js";

/** Follow a changed signature, or an unambiguous rename, without stealing a valid selection. */
export function reconcileMethodSelection(tests: PlaygroundTestConfig, methods: PlaygroundMethod[], previous: PlaygroundMethod[]): PlaygroundTestConfig {
	if (!tests.selectedMethod) return tests;
	const selected = methods.find(method => method.id === tests.selectedMethod);
	if (selected) {
		const saved = tests.casesByMethod[selected.id];
		if (!saved?.some(test => test.args.some((value, index) => !value.isNull && !value.text.trim() && selected.parameters[index]?.type !== "str"))) return tests;
		return { ...tests, casesByMethod: { ...tests.casesByMethod, [selected.id]: saved.map(test => ({ ...test, args: test.args.map((value, index) => !value.isNull && !value.text.trim() && selected.parameters[index]?.type !== "str" ? defaultParameterValue(selected.parameters[index]?.type ?? "JSON") : value) })) } };
	}
	const old = previous.find(method => method.id === tests.selectedMethod);
	const name = old?.name ?? tests.selectedMethod.split("(")[0];
	const added = methods.filter(method => !previous.some(before => before.id === method.id));
	const removed = previous.filter(method => !methods.some(after => after.id === method.id));
	const target = methods.find(method => method.name === name)
		?? (old && removed.length === 1 && added.length === 1 ? added[0] : undefined);
	if (!target) return tests;
	const names = old?.parameters.map(parameter => parameter.name) ?? tests.selectedMethod.slice(tests.selectedMethod.indexOf("(") + 1, -1).split(",");
	const source = tests.casesByMethod[tests.selectedMethod] ?? [];
	const existing = Object.hasOwn(tests.casesByMethod, target.id) ? tests.casesByMethod[target.id] : undefined;
	const migrated = { ...tests, selectedMethod: target.id, casesByMethod: { ...tests.casesByMethod, [target.id]: existing ?? source.map(test => ({ ...test, args: target.parameters.map(parameter => test.args[names.indexOf(parameter.name)] ?? defaultParameterValue(parameter.type)) })) } };
	return reconcileMethodSelection(migrated, methods, previous);
}
