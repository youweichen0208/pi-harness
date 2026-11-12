import { describe, expect, it } from "vitest";
import { discoverPythonMethods } from "../../server/playground-methods.js";
import { reconcileMethodSelection } from "../../web/src/playground-method-selection.js";
import type { PlaygroundTestConfig } from "../../server/protocol.js";
const methods = (source: string) => discoverPythonMethods(source).methods;
const previous = methods("def add(a, b): pass");
const tests: PlaygroundTestConfig = { mode: "program", selectedMethod: "add(a,b)", casesByMethod: { "add(a,b)": [{ id: "one", args: [{ text: "2" }, { text: "3" }] }] } };
describe("signature selection", () => {
	it("follows parameter changes and preserves values by name", () => {
		const next = reconcileMethodSelection(tests, methods("def add(b, c, a): pass"), previous);
		expect(next.selectedMethod).toBe("add(b,c,a)");
		expect(next.casesByMethod[next.selectedMethod][0].args.map(v => v.text)).toEqual(["3", "null", "2"]);
		expect(next.casesByMethod[tests.selectedMethod]).toEqual(tests.casesByMethod[tests.selectedMethod]);
	});
	it("follows a unique rename", () => {
		expect(reconcileMethodSelection(tests, methods("def sum(a,b): pass"), previous).selectedMethod).toBe("sum(a,b)");
	});
	it("keeps selection when adding an unrelated function", () => {
		expect(reconcileMethodSelection(tests, methods("def add(a,b): pass\ndef other(x): pass"), previous)).toBe(tests);
	});
	it("does not guess between multiple replacements or incomplete code", () => {
		expect(reconcileMethodSelection(tests, methods("def one(a): pass\ndef two(b): pass"), previous)).toBe(tests);
		expect(reconcileMethodSelection(tests, [], previous)).toBe(tests);
	});
});
it("repairs saved empty parameters even when the selected signature is unchanged", () => {
	const current = methods("def add(a: int,b: int): pass");
	const saved = { ...tests, casesByMethod: { "add(a,b)": [{ id: "one", args: [{ text: "2" }, { text: "" }] }] } };
	const next = reconcileMethodSelection(saved, current, current);
	expect(next.casesByMethod["add(a,b)"][0].args[1].text).toBe("0");
});
